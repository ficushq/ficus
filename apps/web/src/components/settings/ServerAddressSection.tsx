import { useState } from 'react'
import { PhoneReachGuide } from './PhoneReachGuide'
import { isCloudManaged, PublicAddressSettings, usePublicAddressStatus } from './PublicAddressSettings'

/** Administration → Configuration → Server address: the server-wide public address. */
export function ServerAddressSection() {
  const { query } = usePublicAddressStatus()
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Server address</h3>
        <p className="mt-1 text-sm text-muted">
          The public address people and mobile devices use to reach this server. Ficus uses it for links, sign-in and
          passkeys, integration OAuth callbacks and webhooks, and the Ficus app.
        </p>
      </header>
      <ServerAddressSetup showGuide={!!query.data && !isCloudManaged(query.data)} />
    </div>
  )
}

/**
 * The address and how to make it reachable from a mobile device, without the page heading. Settings shows it
 * under that heading; onboarding's optional setup shows it inline.
 */
export function ServerAddressSetup({ showGuide = true }: { showGuide?: boolean }) {
  const [message, setMessage] = useState('')
  // The guide offers addresses; choosing one opens the form above with it.
  const [proposed, setProposed] = useState<{ url: string; n: number }>()
  return (
    <div className="space-y-6">
      <section className="ficus-section py-5">
        <PublicAddressSettings onSaved={setMessage} proposed={proposed} />
      </section>
      {showGuide && (
        <section className="ficus-section py-5">
          <PhoneReachGuide
            onUse={(url) => {
              setProposed((previous) => ({ url, n: (previous?.n ?? 0) + 1 }))
              document.querySelector('[data-setting-target="server-address"]')?.scrollIntoView({ block: 'start' })
            }}
          />
        </section>
      )}
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  )
}
