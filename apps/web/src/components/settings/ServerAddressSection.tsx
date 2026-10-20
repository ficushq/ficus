import { useState } from 'react'
import { PublicAddressSettings } from './PublicAddressSettings'

/** Administration → Configuration → Server address: the server-wide public address. */
export function ServerAddressSection() {
  const [message, setMessage] = useState('')
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Server address</h3>
        <p className="mt-1 text-sm text-muted">
          The public address people and phones use to reach this server. Ficus uses it for links, sign-in and passkeys,
          integration OAuth callbacks and webhooks, and the Ficus app.
        </p>
      </header>
      <section className="ficus-section py-5">
        <PublicAddressSettings onSaved={setMessage} />
      </section>
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  )
}
