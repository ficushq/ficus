import { RelayConnectionSettings } from './RelayConnectionSettings'

export function MobileProSection() {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Mobile & Pro</h3>
        <p className="mt-1 text-sm text-muted">
          Manage this server’s mobile relay connection and Instance Pro coverage.
        </p>
      </header>
      <RelayConnectionSettings />
    </div>
  )
}
