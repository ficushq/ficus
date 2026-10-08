import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStream } from '@ficus/shared'
import { client } from '../api/clientInstance'
import { queryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'

export function useWorkStreamPauseControls(stream: WorkStream) {
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
  const eligible = can('workstreams:update') && !['done', 'canceled'].includes(stream.status)
  const paused = Boolean(stream?.pause)
  const { reset } = action
  useEffect(() => {
    setEditing(false)
    setReason('')
    setMinutes('')
    reset()
  }, [stream.id, paused, eligible, reset])
  return {
    action,
    editing,
    reason,
    setReason,
    minutes,
    setMinutes,
    canPause: eligible && !stream.pause,
    canPark: eligible && Boolean(stream.pause) && stream.status === 'active',
    canResume: eligible && Boolean(stream.pause),
    openPause: () => {
      if (eligible && !stream.pause && !action.isPending) setEditing(true)
    },
    closePause: () => setEditing(false),
    park: () => {
      if (eligible && stream.pause && stream.status === 'active' && !action.isPending) action.mutate('park')
    },
  }
}

export function WorkStreamPauseControls({
  stream,
  controls,
}: {
  stream: WorkStream
  controls: ReturnType<typeof useWorkStreamPauseControls>
}) {
  const { action, editing, reason, setReason, minutes, setMinutes } = controls
  if (['done', 'canceled'].includes(stream.status)) return null
  if (!stream.pause && !(editing && controls.canPause) && !action.error) return null
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
      {(controls.canPause || controls.canResume) && (
        <>
          {controls.canResume && (
            <button
              type="button"
              className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-xs font-medium"
              disabled={action.isPending}
              onClick={() => action.mutate('resume')}
            >
              Resume work
            </button>
          )}
          {editing && !stream.pause && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (controls.canPause && !action.isPending) action.mutate('pause')
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
                  autoFocus
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
                className="ficus-button ficus-button-secondary rounded-md px-3 py-1.5 text-xs font-medium"
                disabled={action.isPending}
              >
                Pause now
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs"
                disabled={action.isPending}
                onClick={controls.closePause}
              >
                Cancel
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
