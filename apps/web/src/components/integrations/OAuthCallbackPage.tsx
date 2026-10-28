import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import { callbackIntegrationAuthorization, completeIntegrationAuthorization } from '../../api/integrations'
import {
  clearPreparedOAuthCallback,
  readPreparedOAuthCallback,
  type BrokerCompletionPayload,
  type LocalCallbackPayload,
} from '../../lib/oauthCallbackBootstrap'
import { integrationQueryKeys } from '../../queryKeys'
import { integrationReturnPath } from '../../lib/integrationReturnPath'

const TERMINAL_COMPLETION_CODES = new Set([
  'client_authority_mismatch',
  'completion_not_found',
  'flow_expired',
  'grant_abandoned',
  'invalid_completion_handle',
  'invalid_grant',
  'invalid_or_expired_state',
  'operation_key_conflict',
])

type CompletionRequest =
  { kind: 'broker'; body: BrokerCompletionPayload } | { kind: 'local'; body: LocalCallbackPayload }
type PageState = 'working' | 'retryable_failure' | 'terminal_failure' | 'cancelled'

function isTerminalCompletionFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return false
  const code = (error.payload as Record<string, unknown>).error
  return typeof code === 'string' && TERMINAL_COMPLETION_CODES.has(code)
}

export function OAuthCallbackPage() {
  // Only GitHub's callback URL carries a path suffix; every other broker/local
  // flow shares this path, so `prepareOAuthCallbackHistory` carries the
  // initiating component's provider hint in the same reload-surviving history
  // state as the completion payload (see oauthCallbackBootstrap.ts) — reading
  // it here, rather than consuming a one-shot sessionStorage value, means a
  // reload after a retryable failure still knows the right provider.
  const [provider] = useState<'github' | 'notion' | 'slack'>(() => {
    if (window.location.pathname.endsWith('/oauth/callback/github')) return 'github'
    const prepared = readPreparedOAuthCallback()
    return prepared?.kind === 'broker' && prepared.provider === 'slack' ? 'slack' : 'notion'
  })
  const queryClient = useQueryClient()
  const initialized = useRef(false)
  const request = useRef<CompletionRequest | undefined>(undefined)
  const inFlight = useRef(false)
  const [pageState, setPageState] = useState<PageState>('working')

  const complete = useCallback(() => {
    if (!request.current || inFlight.current) return
    inFlight.current = true
    setPageState('working')
    const completion =
      request.current.kind === 'broker'
        ? completeIntegrationAuthorization(provider, request.current.body)
        : callbackIntegrationAuthorization(provider, request.current.body)
    void completion
      .then(async ({ returnTo }) => {
        clearPreparedOAuthCallback()
        request.current = undefined
        await queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all })
        window.location.replace(integrationReturnPath(returnTo, provider))
      })
      .catch((error: unknown) => {
        inFlight.current = false
        if (request.current?.kind === 'local') {
          clearPreparedOAuthCallback()
          request.current = undefined
          setPageState('terminal_failure')
          return
        }
        if (isTerminalCompletionFailure(error)) {
          clearPreparedOAuthCallback()
          request.current = undefined
          setPageState('terminal_failure')
          return
        }
        setPageState('retryable_failure')
      })
  }, [queryClient, provider])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const prepared = readPreparedOAuthCallback()
    if (prepared?.kind === 'broker' || prepared?.kind === 'local') {
      request.current = prepared
      if (prepared.kind === 'local') clearPreparedOAuthCallback()
      complete()
      return
    }
    clearPreparedOAuthCallback()
    setPageState(prepared?.kind === 'cancelled' ? 'cancelled' : 'terminal_failure')
  }, [complete])

  return (
    <section className="mx-auto max-w-lg rounded-lg border border-th-border bg-surface p-6 text-center">
      <h1 className="text-lg font-semibold">
        Connecting {provider === 'github' ? 'GitHub' : provider === 'slack' ? 'Slack' : 'Notion'}
      </h1>
      {pageState === 'cancelled' ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">
          Authorization cancelled. You can return to Settings.
        </p>
      ) : pageState === 'terminal_failure' ? (
        <p role="alert" className="mt-2 text-sm text-status-danger-600">
          Authorization could not be completed. Return to Settings and start again.
        </p>
      ) : pageState === 'retryable_failure' ? (
        <div className="mt-2 text-sm text-status-danger-600">
          <p role="alert">Authorization could not be completed. Please try again.</p>
          <button
            type="button"
            className="mt-3 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            onClick={complete}
          >
            Try again
          </button>
        </div>
      ) : (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">
          Finishing the secure connection…
        </p>
      )}
    </section>
  )
}
