import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { disableExternalExport, enableExternalExport } from '../api/integrations'
import { integrationQueries } from '../queryOptions'
import { integrationQueryKeys } from '../queryKeys'

export function ExternalExportControl({
  agentId,
  connectionId,
  canExport,
}: {
  agentId: string
  connectionId?: string
  canExport: boolean
}) {
  const client = useQueryClient()
  const { data } = useQuery(integrationQueries.export(agentId))
  const [confirmed, setConfirmed] = useState(false)
  const refresh = () => client.invalidateQueries({ queryKey: integrationQueryKeys.export(agentId) })
  const enable = useMutation({
    mutationFn: () => enableExternalExport(agentId, connectionId!),
    onSuccess: () => {
      setConfirmed(false)
      refresh()
    },
  })
  const disable = useMutation({ mutationFn: () => disableExternalExport(agentId), onSuccess: refresh })
  if (!canExport) return null
  return (
    <section className="mt-4">
      <h3 className="text-sm font-medium">External conversation export</h3>
      {data?.state === 'enabled' ? (
        <>
          <p className="text-xs text-muted">
            Future eligible user/assistant text is exported. Tool data, thinking, images, and internal messages are
            excluded. Revoking stops future sends but does not delete remote data.
          </p>
          <button
            className="ficus-button ficus-button-danger mt-2 px-3 py-1.5 text-sm"
            onClick={() => disable.mutate()}
          >
            Revoke export consent
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted">
            Disabled by default. Enabling sends only future eligible user/assistant text to the configured Bigbrain. It
            never sends tool data, thinking, images, or internal messages. Revocation cannot delete data already
            delivered.
          </p>
          <label>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I
            explicitly consent to prospective export
          </label>
          <button
            className="ficus-button ficus-button-primary ml-2 px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={!confirmed || !connectionId}
            onClick={() => enable.mutate()}
          >
            Enable export
          </button>
        </>
      )}
    </section>
  )
}
