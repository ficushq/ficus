import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import {
  callbackIntegrationAuthorization,
  completeIntegrationAuthorization,
  resolveIntegrationAuthorizationProvider,
} from '../../api/integrations'
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

const PROVIDER_LABELS: Record<string, string> = { github: 'GitHub', linear: 'Linear', notion: 'Notion', slack: 'Slack' }

/** Safe broker failure codes a person can act on; any other safe code is shown as it is. */
const FAILURE_REASONS: Record<string, string> = {
  broker_unconfigured: 'This provider is not set up for this Ficus instance yet.',
  invalid_grant: 'The provider did not accept the authorization.',
  provider_error: 'The provider returned an error.',
  provider_timeout: 'The provider did not respond in time.',
  provider_unavailable: 'The provider is unavailable right now.',
  rate_limited: 'The provider is limiting requests. Wait a minute before starting again.',
}

const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Only GitHub broker callbacks and self-hosted Linear callbacks name their provider in the path. */
function providerFromPath(): 'github' | 'linear' | undefined {
  if (window.location.pathname.endsWith('/oauth/callback/github')) return 'github'
  if (window.location.pathname.endsWith('/oauth/callback/linear')) return 'linear'
  return undefined
}

type CompletionRequest =
  { kind: 'broker'; body: BrokerCompletionPayload } | { kind: 'local'; body: LocalCallbackPayload }
type PageState = 'working' | 'retryable_failure' | 'terminal_failure' | 'cancelled'

function isTerminalCompletionFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || !error.payload || typeof error.payload !== 'object') return false
  const code = (error.payload as Record<string, unknown>).error
  return typeof code === 'string' && TERMINAL_COMPLETION_CODES.has(code)
}

export function OAuthCallbackPage() {
  // Every flow other than GitHub's broker and self-hosted Linear returns to this one path, often in a
  // tab that never saw the start (a flow started in the Desktop app opens the system browser). So a
  // completion asks Core which provider started the flow it names, and never guesses. A cancelled or
  // failed callback names no flow; the initiating tab's hint, when present, only labels it.
  //
  // What the callback carries is read once, when the page opens.
  const [prepared] = useState(readPreparedOAuthCallback)
  const [provider, setProvider] = useState<string | undefined>(
    () =>
      providerFromPath() ??
      (prepared?.kind === 'cancelled' || prepared?.kind === 'terminal' ? prepared.provider : undefined)
  )
  const resolvedProvider = useRef<string | undefined>(providerFromPath())
  const reason = prepared?.kind === 'terminal' ? prepared.reason : undefined
  const queryClient = useQueryClient()
  const initialized = useRef(false)
  const request = useRef<CompletionRequest | undefined>(undefined)
  const inFlight = useRef(false)
  // A broker or local completion starts working at once; anything else is already settled.
  const [pageState, setPageState] = useState<PageState>(() =>
    prepared?.kind === 'broker' || prepared?.kind === 'local'
      ? 'working'
      : prepared?.kind === 'cancelled'
        ? 'cancelled'
        : 'terminal_failure'
  )

  const complete = useCallback(() => {
    if (!request.current || inFlight.current) return
    inFlight.current = true
    setPageState('working')
    const current = request.current
    const resolve = async (): Promise<string> => {
      if (resolvedProvider.current) return resolvedProvider.current
      const { provider: resolved } = await resolveIntegrationAuthorizationProvider(
        current.kind === 'broker' ? { localFlowId: current.body.localFlowId } : { state: current.body.state }
      )
      // Core answers with a provider key; anything else must never become part of a request path.
      if (typeof resolved !== 'string' || !PROVIDER_KEY_PATTERN.test(resolved))
        throw new ApiError(400, 'Unexpected provider', { error: 'invalid_or_expired_state' })
      resolvedProvider.current = resolved
      setProvider(resolved)
      return resolved
    }
    void resolve()
      .then(async (completionProvider) => {
        const { returnTo } =
          current.kind === 'broker'
            ? await completeIntegrationAuthorization(completionProvider, current.body)
            : await callbackIntegrationAuthorization(completionProvider, current.body)
        clearPreparedOAuthCallback()
        request.current = undefined
        await queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all })
        window.location.replace(integrationReturnPath(returnTo, completionProvider))
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
  }, [queryClient])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (prepared?.kind === 'broker' || prepared?.kind === 'local') {
      request.current = prepared
      if (prepared.kind === 'local') clearPreparedOAuthCallback()
      complete()
      return
    }
    clearPreparedOAuthCallback()
  }, [complete, prepared])

  return (
    <section className="mx-auto max-w-lg rounded-lg border border-th-border bg-surface p-6 text-center">
      <h1 className="text-lg font-semibold">
        {provider && PROVIDER_LABELS[provider] ? `Connecting ${PROVIDER_LABELS[provider]}` : 'Finishing the connection'}
      </h1>
      {pageState === 'cancelled' ? (
        <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">
          Authorization cancelled. You can return to Settings.
        </p>
      ) : pageState === 'terminal_failure' ? (
        <div role="alert" className="mt-2 text-sm text-status-danger-600">
          <p>Authorization could not be completed. Return to Settings and start again.</p>
          {reason ? (
            <p className="mt-1">
              {FAILURE_REASONS[reason] ?? 'The provider reported an error.'} (Code: {reason})
            </p>
          ) : null}
        </div>
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
