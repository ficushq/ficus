import { FarmScreen } from '../farm/FarmScreen'
import { useFarmData } from '../farm/useFarmData'
import type { LiveStatus } from '../live/LiveUpdates'

export function Farm({ live }: { live: LiveStatus }) {
  const { input, error } = useFarmData()
  if (!input) {
    return (
      <main className="g-splash">
        <div className="g-card g-splash-card">
          <h1 className="g-wordmark">ficus farm</h1>
          <p>{error ? "The farm couldn't load your squads." : 'Walking out to the fields…'}</p>
        </div>
      </main>
    )
  }
  return <FarmScreen input={input} live={live} />
}
