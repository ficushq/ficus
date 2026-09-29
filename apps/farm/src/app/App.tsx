import { lazy, Suspense, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isHttpResponseError } from '@ficus/client-core'
import { farmQueries } from '../api/queries'
import { webAppUrl } from '../api/base'
import { useLiveUpdates } from '../live/LiveUpdates'
import { exchangeHandoff, isEmbedded, onAppMessage, postToApp } from '../embed/embed'
import { useStableRef } from '../hooks/useStableRef'
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

  // Tell an embedding app the farm is up (once per sign-in).
  useEffect(() => {
    if (signedIn) postToApp({ type: 'ready' })
  }, [signedIn])

  if (session.isPending) return <Splash message="Opening the farm gate…" />
  if (session.isError) {
    const signedOut = isHttpResponseError(session.error) && session.error.status === 401
    // Inside Ficus Mobile the app signs the farm in; there is no web sign-in to send you to.
    if (signedOut && isEmbedded()) return <AppSignIn onSignedIn={() => void session.refetch()} />
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

/**
 * Signed out inside the app's web view: ask the app for a web handoff code and
 * trade it for a session, then carry on.
 */
export function AppSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [failed, setFailed] = useState(false)
  const onSignedInRef = useStableRef(onSignedIn)
  useEffect(() => {
    let active = true
    // One exchange at a time: a second code (a repeated auth-required answer) waits its turn out.
    let exchanging = false
    const stop = onAppMessage((message) => {
      if (message.type !== 'handoff' || exchanging || !active) return
      exchanging = true
      void exchangeHandoff(message.code).then((ok) => {
        exchanging = false
        if (!active) return
        if (ok) {
          active = false
          onSignedInRef.current()
        } else setFailed(true)
      })
    })
    postToApp({ type: 'auth-required' })
    return () => {
      active = false
      stop()
    }
  }, [onSignedInRef])
  if (!failed) return <Splash message="Signing you in…" />
  return (
    <Splash message="The farm couldn't sign you in.">
      <button
        className="g-button"
        type="button"
        onClick={() => {
          setFailed(false)
          postToApp({ type: 'auth-required' })
        }}
      >
        Try again
      </button>
    </Splash>
  )
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
