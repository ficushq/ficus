import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { DesktopUpdates, DesktopUpdateState } from '../../lib/desktop'

const BUSY_PHASES = new Set<DesktopUpdateState['phase']>(['checking', 'downloading', 'installing'])

const secondaryButton = clsx(
  'ficus-button',
  'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
  'bg-surface border border-th-border text-primary hover:bg-surface-hover',
  'disabled:opacity-50 disabled:cursor-not-allowed'
)
const primaryButton = clsx(
  'ficus-button',
  'px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
  'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
  'disabled:opacity-50 disabled:cursor-not-allowed'
)

function formatLastChecked(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return 'unknown'
  if (ms < 60_000) return 'just now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Native update controls for the Tau Desktop app, which owns the bundled Core's upgrades. */
export function DesktopUpdatePanel({ updates, canWrite }: { updates: DesktopUpdates; canWrite: boolean }) {
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  const [bridgeError, setBridgeError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = updates.subscribe((next) => {
      if (active) setState(next)
    })
    updates.state().then(
      // A pushed state is newer than the initial snapshot; never overwrite it.
      (initial) => active && setState((current) => current ?? initial),
      (error: unknown) => active && setBridgeError(errorMessage(error))
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [updates])

  const check = () => {
    setBridgeError(null)
    updates.check().then(
      (next) => setState(next),
      (error: unknown) => setBridgeError(errorMessage(error))
    )
  }
  const install = () => {
    setBridgeError(null)
    updates.install().catch((error: unknown) => setBridgeError(errorMessage(error)))
  }

  const phase = state?.phase
  const busy = phase !== undefined && BUSY_PHASES.has(phase)
  const progress = state?.progress
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.max(0, (progress.receivedBytes / progress.totalBytes) * 100))
      : undefined

  return (
    <section className="space-y-6 text-primary" data-testid="desktop-update-panel">
      <div>
        <h2 className="text-xl font-semibold text-primary">Tau Desktop updates</h2>
        <p className="text-sm text-muted mt-1">
          The desktop app updates itself and the Tau Core it bundles together, then restarts to finish.
        </p>
      </div>
      {!state ? (
        bridgeError ? (
          <p role="alert" className="text-sm text-danger">
            {bridgeError}
          </p>
        ) : (
          <p className="text-sm text-muted">Loading update status…</p>
        )
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">App version</dt>
            <dd className="text-primary">{state.appVersion || 'unknown'}</dd>
            <dt className="text-muted">Core commit</dt>
            <dd className="text-primary font-mono" title={state.coreCommit || undefined}>
              {state.coreCommit ? state.coreCommit.slice(0, 7) : 'unknown'}
            </dd>
          </dl>
          {!state.supported && (
            <div className="p-3 rounded bg-warning/10 text-warning text-sm">
              This build of Tau Desktop doesn’t receive automatic updates.
            </div>
          )}
          <div className="space-y-3" data-setting-target="desktop-update-status">
            <DesktopUpdateStatus
              state={state}
              percent={percent}
              canWrite={canWrite}
              onRestart={install}
              onRetry={check}
            />
            {state.lastCheckedAt && (
              <p className="text-sm text-muted">Last checked {formatLastChecked(state.lastCheckedAt)}</p>
            )}
            {bridgeError && (
              <p role="alert" className="text-sm text-danger">
                {bridgeError}
              </p>
            )}
          </div>
          {canWrite && state.supported && (
            <div className="flex gap-2">
              <button type="button" className={secondaryButton} onClick={check} disabled={busy}>
                {phase === 'checking' ? 'Checking…' : 'Check now'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function DesktopUpdateStatus({
  state,
  percent,
  canWrite,
  onRestart,
  onRetry,
}: {
  state: DesktopUpdateState
  percent: number | undefined
  canWrite: boolean
  onRestart: () => void
  onRetry: () => void
}) {
  const version = state.availableVersion ? `Tau ${state.availableVersion}` : 'the update'
  switch (state.phase) {
    case 'checking':
      return (
        <p role="status" className="text-sm text-primary">
          Checking…
        </p>
      )
    case 'downloading':
      return (
        <div className="space-y-2">
          <p role="status" className="text-sm text-primary">
            Downloading {state.availableVersion ?? 'update'}…
            {percent !== undefined && <span className="text-muted"> {Math.round(percent)}%</span>}
          </p>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-inset"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={percent === undefined ? undefined : 0}
            aria-valuemax={percent === undefined ? undefined : 100}
            aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
          >
            {percent === undefined ? (
              <div className="h-full w-1/3 rounded-full bg-accent motion-safe:animate-pulse" />
            ) : (
              <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
            )}
          </div>
        </div>
      )
    case 'ready':
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-sm text-primary">
            {version} is ready
          </p>
          {canWrite && (
            <button type="button" className={primaryButton} onClick={onRestart}>
              Restart to update
            </button>
          )}
        </div>
      )
    case 'installing':
      return (
        <p role="status" className="text-sm text-primary">
          Restarting to install {version}…
        </p>
      )
    case 'error':
      return (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-sm text-danger">
            {state.error || 'The update check failed.'}
          </p>
          {canWrite && (
            <button type="button" className={secondaryButton} onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )
    default:
      // Builds without the native updater already show a note; "Up to date" would be misleading.
      if (!state.supported) return null
      return (
        <p role="status" className="text-sm text-primary">
          Up to date
        </p>
      )
  }
}
