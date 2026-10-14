import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { setSetting } from '../../../api/settings'
import { queryKeys } from '../../../queryKeys'

/** AGENT_DORMANT_RETENTION_DAYS: how long dormant agents keep their files before final removal. */
export function DormantRetentionSettings({ days }: { days: number }) {
  const [value, setValue] = useState(String(days))
  const client = useQueryClient()
  const save = useMutation({
    mutationFn: () => setSetting('AGENT_DORMANT_RETENTION_DAYS', value.trim()),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.system.all }),
        client.invalidateQueries({ queryKey: queryKeys.settings.list() }),
      ])
    },
  })
  return (
    <form
      className="space-y-3 border-b border-th-border pb-5"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <h3 className="font-medium">Dormant agents</h3>
      <label className="block space-y-1 text-sm">
        Remove dormant agents after (days)
        <input
          className="ficus-field block w-48 px-3 py-2"
          type="number"
          min="1"
          max="3650"
          step="1"
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="text-xs text-secondary">
        A dormant agent keeps its files and can be woken by a new message until then. Removal archives and deletes its
        home, frees its space, and cannot be undone.
      </p>
      <button className="ficus-button ficus-button-primary px-3 py-2 text-sm" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save retention'}
      </button>
      {save.isError && (
        <p role="alert" className="text-sm text-status-danger-400">
          {save.error.message}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-sm text-secondary">
          Retention saved.
        </p>
      )}
    </form>
  )
}
