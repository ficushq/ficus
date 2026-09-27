import { ChannelIdsEditor } from '../settings/ChannelIdsEditor'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateChannelInstance } from '../../api/config'
import { SquadOverridesEditor, TrustedChannelsField } from '../settings/ChannelsSection'
import {
  type ProviderId,
  type OverrideRow,
  mapToOverrideRows,
  overrideRowsToMap,
  invalidOverrideRowIndexes,
} from '../settings/channelFormHelpers'

/** One routing policy for the identity discovered from this provider's connection. */
export function ProviderChannelRouting({
  provider,
  instanceId,
  canWrite,
}: {
  provider: ProviderId
  instanceId: string
  canWrite: boolean
}) {
  const client = useQueryClient()
  const query = useQuery(queries.channelInstances.detail(instanceId))
  const [rows, setRows] = useState<OverrideRow[]>([])
  const [trusted, setTrusted] = useState<string[]>([])
  const [allowed, setAllowed] = useState<string[]>([])
  const [denied, setDenied] = useState<string[]>([])
  const [allowPrivateChats, setAllowPrivateChats] = useState(query.data?.allowPrivateChats ?? true)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!query.data) return
    setAllowPrivateChats(query.data.allowPrivateChats ?? true)
    setRows(mapToOverrideRows(query.data.channelSquadMap))
    setTrusted(query.data.trustedChannelIds ?? [])
    setAllowed(query.data.allowedChannelIds ?? [])
    setDenied(query.data.deniedChannelIds ?? [])
  }, [query.data])
  const save = useMutation({
    mutationFn: () =>
      updateChannelInstance(instanceId, {
        channelSquadMap: overrideRowsToMap(rows),
        allowPrivateChats,
        trustedChannelIds: trusted.map((id) => id.trim()),
        allowedChannelIds: allowed.map((id) => id.trim()),
        deniedChannelIds: denied.map((id) => id.trim()),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.channelInstances.all }),
  })
  return (
    <section className="space-y-4 text-sm" aria-label="Channel routing and access">
      <div>
        <h4 className="font-medium text-primary">Channel routing and access</h4>
        <p className="text-muted mt-1">
          Overrides select a squad for a specific channel or chat on this connection. Other messages use the default
          squad above.
        </p>
      </div>
      {query.isPending ? (
        <p className="text-muted">Loading routing…</p>
      ) : query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : (
        <fieldset disabled={!canWrite || save.isPending} className="space-y-4">
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowPrivateChats}
                onChange={(event) => setAllowPrivateChats(event.target.checked)}
              />
              Allow private chats
            </label>
            <p className="text-muted mt-1">
              Let linked users talk to Tau and choose squads in bot DMs. Turn off to ignore private messages, including
              commands and account linking, and stop replies to existing private chats.
            </p>
          </div>
          <SquadOverridesEditor provider={provider} rows={rows} onChange={setRows} />
          {(provider === 'slack' || provider === 'discord') && (
            <div className="space-y-4">
              <ChannelIdsEditor kind="Allowed" value={allowed} onChange={setAllowed}>
                Leave empty to allow all channels. Add channels to limit where Tau can interact.
              </ChannelIdsEditor>
              <ChannelIdsEditor kind="Denied" value={denied} onChange={setDenied}>
                Denied channels always win, including for linked users and trusted channels. Leave empty to deny none.
                Threads inherit their parent channel’s policy. Tau ignores messages in excluded channels, including help
                and account linking.
              </ChannelIdsEditor>
            </div>
          )}
          <TrustedChannelsField value={trusted} onChange={setTrusted} />
          {canWrite && (
            <button
              className="ficus-button ficus-button-primary px-3 py-2"
              onClick={() => {
                if (invalidOverrideRowIndexes(rows).length) {
                  setError('Complete each override or remove its row.')
                  return
                }
                setError('')
                save.mutate()
              }}
            >
              Save routing and access
            </button>
          )}
          {save.isSuccess && (
            <p className="text-muted" role="status">
              Saved.
            </p>
          )}
          {(error || save.error) && (
            <p role="alert" className="text-danger">
              {error || save.error?.message}
            </p>
          )}
        </fieldset>
      )}
    </section>
  )
}
