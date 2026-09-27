import { useQuery } from '@tanstack/react-query'
import { gardenQueries } from '../api/queries'
import type { LiveStatus } from '../live/LiveUpdates'

/** Placeholder until the isometric farm scene lands: proves the data layer end to end. */
export function Farm({ live }: { live: LiveStatus }) {
  const squads = useQuery(gardenQueries.squads())
  const streams = useQuery(gardenQueries.liveWorkStreams())
  const pending = useQuery(gardenQueries.pendingActions())

  return (
    <main className="g-splash">
      <div className="g-card g-splash-card">
        <h1 className="g-wordmark">ficus garden</h1>
        <p>
          {squads.data?.length ?? '…'} plots · {streams.data?.length ?? '…'} growing · {pending.data?.length ?? '…'}{' '}
          need you
        </p>
        <p className="g-muted" data-live={live}>
          {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline, retrying'}
        </p>
      </div>
    </main>
  )
}
