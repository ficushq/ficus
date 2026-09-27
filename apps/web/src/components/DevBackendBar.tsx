import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { DEV_BACKEND_SHAPE_SCOPE_KEY } from '../lib/loadingShapeStorage'

const DEV_BACKEND_CONTROL_PATH = '/__ficus_dev'

export interface DevBackendSummary {
  label: string
  apiUrl: string
  isProduction: boolean
}

export interface DevBackendState {
  selectedLabel: string
  apiUrl: string
  isProduction: boolean
  productionWritesEnabled: boolean
  backends: DevBackendSummary[]
}

async function requestDevBackendState(path: string, init?: RequestInit): Promise<DevBackendState> {
  const response = await fetch(`${DEV_BACKEND_CONTROL_PATH}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
    throw new Error(typeof body?.error === 'string' ? body.error : `Dev backend request failed (${response.status})`)
  }
  return response.json()
}

function rememberShapeScope(label: string) {
  try {
    window.localStorage.setItem(DEV_BACKEND_SHAPE_SCOPE_KEY, label)
  } catch {
    // The backend switch still works when browser storage is unavailable.
  }
}

function backendHost(apiUrl: string): string {
  try {
    return new URL(apiUrl).host
  } catch {
    return apiUrl
  }
}

export function DevBackendBarContent({
  state,
  pending,
  error,
  onSwitchBackend,
  onSetProductionWrites,
}: {
  state: DevBackendState | null
  pending: boolean
  error: string | null
  onSwitchBackend: (label: string) => void
  onSetProductionWrites: (enabled: boolean) => void
}) {
  return (
    <div
      className={clsx(
        'z-50 flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs',
        state?.isProduction
          ? state.productionWritesEnabled
            ? 'border-status-danger-700 bg-status-danger-950 text-status-danger-100'
            : 'border-status-attention-400 bg-status-attention-100 text-status-attention-950 dark:border-status-attention-700 dark:bg-status-attention-950 dark:text-status-attention-100'
          : 'border-th-border bg-surface-secondary text-secondary'
      )}
      role="status"
    >
      <span className="rounded bg-chrome-scrim/10 px-1.5 py-0.5 font-semibold uppercase tracking-wide dark:bg-chrome-paper/10">
        Dev UI
      </span>
      {state && (
        <>
          <label className="flex items-center gap-1.5">
            <span>Backend</span>
            <select
              value={state.selectedLabel}
              disabled={pending}
              onChange={(event) => onSwitchBackend(event.target.value)}
              className="ficus-field rounded border border-current/25 bg-transparent px-1.5 py-0.5 font-medium outline-none disabled:opacity-50"
              aria-label="Development backend"
            >
              {state.backends.map((backend) => (
                <option key={backend.label} value={backend.label} className="bg-surface text-primary">
                  {backend.label === '@local' ? 'Local' : backend.label} · {backendHost(backend.apiUrl)}
                </option>
              ))}
            </select>
          </label>
          <span className="font-medium">
            {state.isProduction ? 'Production' : 'Local'} · {backendHost(state.apiUrl)}
          </span>
          {state.isProduction && (
            <div className="flex items-center gap-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 font-semibold">
                <input
                  type="checkbox"
                  checked={state.productionWritesEnabled}
                  disabled={pending}
                  onChange={(event) => onSetProductionWrites(event.target.checked)}
                  className="h-3.5 w-3.5 accent-status-danger-600"
                />
                Enable production writes
              </label>
              <span className="opacity-75">Resets on switch or restart</span>
            </div>
          )}
          {state.isProduction && (
            <span className="font-semibold uppercase tracking-wide">
              {state.productionWritesEnabled ? 'Writes enabled' : 'Read only'}
            </span>
          )}
        </>
      )}
      {error && <span className="font-medium text-status-danger-700 dark:text-status-danger-300">{error}</span>}
    </div>
  )
}

export function DevBackendBar() {
  const enabled = typeof __FICUS_DEV_BACKEND_BAR__ !== 'undefined' && __FICUS_DEV_BACKEND_BAR__
  const [state, setState] = useState<DevBackendState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void requestDevBackendState('/state')
      .then((next) => {
        if (active) {
          rememberShapeScope(next.selectedLabel)
          setState(next)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load dev backends')
      })
    return () => {
      active = false
    }
  }, [enabled])

  if (!enabled || (!state && !error)) return null

  const switchBackend = async (label: string) => {
    setPending(true)
    setError(null)
    try {
      const next = await requestDevBackendState('/backend', { method: 'POST', body: JSON.stringify({ label }) })
      rememberShapeScope(next.selectedLabel)
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch backend')
      setPending(false)
    }
  }

  const setProductionWrites = async (enabled: boolean) => {
    setPending(true)
    setError(null)
    try {
      const next = await requestDevBackendState('/production-writes', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      setState(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update production write access')
    } finally {
      setPending(false)
    }
  }

  return (
    <DevBackendBarContent
      state={state}
      pending={pending}
      error={error}
      onSwitchBackend={(label) => void switchBackend(label)}
      onSetProductionWrites={(nextEnabled) => void setProductionWrites(nextEnabled)}
    />
  )
}
