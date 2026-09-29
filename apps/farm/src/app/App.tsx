import { lazy, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isHttpResponseError } from '@ficus/client-core'
import { farmQueries } from '../api/queries'
import { webAppUrl } from '../api/base'
import { useLiveUpdates } from '../live/LiveUpdates'
import { Farm } from './Farm'

import { isDemo } from './demo'

const DemoFarm = import.meta.env.DEV ? lazy(() => import('../dev/DemoFarm')) : null

export function App() {
  if (isDemo && DemoFarm) {
    return (
      <Suspense fallback={null}>
        <DemoFarm />
      </Suspense>
    )
  }
  return <SignedInFarm />
}

function SignedInFarm() {
  const session = useQuery(farmQueries.session())
  const signedIn = session.isSuccess
  const live = useLiveUpdates(signedIn)

  if (session.isPending) return <Splash message="Opening the farm gate…" />
  if (session.isError) {
    const signedOut = isHttpResponseError(session.error) && session.error.status === 401
    return signedOut ? (
      <Splash message="Sign in to Ficus to visit your farm.">
        {/* Signs in on the web app, which then sends you back here (an installed farm app included). */}
        <a className="g-button g-button-primary" href={webAppUrl('/farm-sign-in')}>
          Sign in
        </a>
      </Splash>
    ) : (
      <Splash message="The farm couldn't reach Ficus.">
        <button className="g-button" type="button" onClick={() => void session.refetch()}>
          Try again
        </button>
      </Splash>
    )
  }
  return <Farm live={live} />
}

function Splash({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <main className="g-splash">
      <div className="g-card g-splash-card">
        <h1 className="g-wordmark">Ficus Farm</h1>
        <p>{message}</p>
        {children}
      </div>
    </main>
  )
}
