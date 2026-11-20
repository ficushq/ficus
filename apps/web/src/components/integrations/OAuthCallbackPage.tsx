import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { integrationReturnPath, integrationSettingsPath } from '../../lib/integrationReturnPath'
import { appBasePath } from '../../lib/basePath'
import { FicusLogo } from '../FicusLogo'
import { CheckIcon, CloseIcon, LinkIcon, SpinnerIcon, WarningIcon } from '../icons'
import { IntegrationLogo } from './IntegrationLogo'

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

const PROVIDER_LABELS = { github: 'GitHub', linear: 'Linear', notion: 'Notion', slack: 'Slack' } as const
type LabelledProvider = keyof typeof PROVIDER_LABELS

function labelledProvider(provider: string | undefined): LabelledProvider | undefined {
  return provider && Object.hasOwn(PROVIDER_LABELS, provider) ? (provider as LabelledProvider) : undefined
}

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
type PageState = 'working' | 'success' | 'retryable_failure' | 'terminal_failure' | 'cancelled'

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
  const [returnPath, setReturnPath] = useState<string | undefined>(undefined)

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
        const destination = integrationReturnPath(returnTo, completionProvider)
        // Core has saved the connection: say so while the integration queries refresh, and offer the
        // same destination as a link in case the redirect is slow.
        setReturnPath(destination)
        setPageState('success')
        await queryClient.invalidateQueries({ queryKey: integrationQueryKeys.all })
        window.location.replace(destination)
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

  // A retry removes the focused Try again button, and every later state replaces the page's content,
  // so keep keyboard focus in the page by moving it to the new heading.
  const heading = useRef<HTMLHeadingElement>(null)
  const shownState = useRef(pageState)
  useEffect(() => {
    if (shownState.current === pageState) return
    shownState.current = pageState
    heading.current?.focus({ preventScroll: true })
  }, [pageState])

  const known = labelledProvider(provider)
  const name = known ? PROVIDER_LABELS[known] : undefined
  const basePath = appBasePath()
  // A failed or cancelled callback never learns the flow's return path, so it offers the provider's
  // settings when the provider is known and the integrations page otherwise.
  const settingsHref = known
    ? integrationSettingsPath(known, basePath)
    : `${basePath.replace(/\/$/, '')}/settings?section=integrations`
  const settingsLink = (
    <ActionLink href={settingsHref} variant={pageState === 'retryable_failure' ? 'secondary' : 'primary'}>
      {name ? `Back to ${name} settings` : 'Back to Settings'}
    </ActionLink>
  )
  const homeLink = (
    <ActionLink href={basePath} variant={pageState === 'retryable_failure' ? 'ghost' : 'secondary'}>
      Go to Ficus home
    </ActionLink>
  )

  const content: Record<PageState, { title: string; body: ReactNode; actions?: ReactNode }> = {
    working: {
      title: name ? `Connecting ${name}` : 'Finishing the connection',
      body: (
        <p role="status" aria-live="polite">
          Finishing the secure connection…
        </p>
      ),
    },
    success: {
      title: name ? `${name} connected` : 'Connection finished',
      body: (
        <p role="status" aria-live="polite">
          The connection is saved. Taking you back to Ficus…
        </p>
      ),
      actions: returnPath ? (
        <ActionLink href={returnPath} variant="primary">
          Continue
        </ActionLink>
      ) : undefined,
    },
    cancelled: {
      title: name ? `${name} connection cancelled` : 'Connection cancelled',
      body: (
        <p role="status" aria-live="polite">
          Authorization cancelled. Nothing was connected; you can start again from Settings.
        </p>
      ),
      actions: (
        <>
          {settingsLink}
          {homeLink}
        </>
      ),
    },
    retryable_failure: {
      title: name ? `${name} is not connected yet` : 'The connection is not finished yet',
      body: <p role="alert">Authorization could not be completed. Please try again.</p>,
      actions: (
        <>
          <button type="button" className={`ficus-button ficus-button-primary ${ACTION_CLASSES}`} onClick={complete}>
            Try again
          </button>
          {settingsLink}
          {homeLink}
        </>
      ),
    },
    terminal_failure: {
      title: name ? `Couldn't connect ${name}` : `Couldn't finish the connection`,
      body: (
        <div role="alert">
          <p>Authorization could not be completed. Return to Settings and start again.</p>
          {reason ? (
            <p className="mt-2 text-muted">
              {FAILURE_REASONS[reason] ?? 'The provider reported an error.'} (Code:{' '}
              <code className="font-mono text-xs">{reason}</code>)
            </p>
          ) : null}
        </div>
      ),
      actions: (
        <>
          {settingsLink}
          {homeLink}
        </>
      ),
    },
  }
  const { title, body, actions } = content[pageState]

  // A standalone screen (App renders it outside the app shell): the connection is the only thing on it.
  return (
    <div className="h-full overflow-y-auto bg-page text-primary">
      <main
        aria-labelledby="oauth-callback-title"
        className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center px-6 py-12 text-center"
      >
        <ConnectionMark provider={known} state={pageState} />
        <h1
          ref={heading}
          id="oauth-callback-title"
          tabIndex={-1}
          className="mt-8 text-2xl font-semibold tracking-tight text-balance outline-none"
        >
          {title}
        </h1>
        <div className="mt-3 text-sm leading-6 text-secondary text-pretty">{body}</div>
        {actions ? (
          <div className="mt-8 flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center md:w-max md:flex-nowrap">
            {actions}
          </div>
        ) : null}
      </main>
    </div>
  )
}

const ACTION_CLASSES = 'inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm sm:min-h-10'
const ACTION_VARIANTS = {
  primary: 'ficus-button ficus-button-primary',
  secondary: 'ficus-button ficus-button-secondary',
  ghost: 'ficus-button ficus-button-ghost',
} as const

function ActionLink({
  href,
  variant,
  children,
}: {
  href: string
  variant: keyof typeof ACTION_VARIANTS
  children: ReactNode
}) {
  // Plain links: leaving this screen loads the app afresh, with its navigation and current data.
  return (
    <a href={href} className={`${ACTION_VARIANTS[variant]} ${ACTION_CLASSES}`}>
      {children}
    </a>
  )
}

const STATE_BADGES: Record<PageState, { className: string; icon: ReactNode }> = {
  working: {
    className:
      'bg-status-progress-100 text-status-progress-700 dark:bg-status-progress-900/40 dark:text-status-progress-300',
    icon: <SpinnerIcon className="h-4 w-4 animate-spin" />,
  },
  success: {
    className:
      'bg-status-success-100 text-status-success-700 dark:bg-status-success-900/40 dark:text-status-success-400',
    icon: <CheckIcon className="h-4 w-4" />,
  },
  cancelled: { className: 'bg-surface-secondary text-secondary', icon: <CloseIcon className="h-4 w-4" /> },
  retryable_failure: {
    className: 'bg-status-danger-100 text-status-danger-700 dark:bg-status-danger-900/40 dark:text-status-danger-400',
    icon: <WarningIcon className="h-4 w-4" />,
  },
  terminal_failure: {
    className: 'bg-status-danger-100 text-status-danger-700 dark:bg-status-danger-900/40 dark:text-status-danger-400',
    icon: <WarningIcon className="h-4 w-4" />,
  },
}

/** Ficus and the provider side by side, joined by the connection's state. Decorative: the text says it all. */
function ConnectionMark({ provider, state }: { provider?: LabelledProvider; state: PageState }) {
  const badge = STATE_BADGES[state]
  const tile = 'ficus-inset grid h-16 w-16 shrink-0 place-items-center'
  return (
    <div aria-hidden="true" data-state={state} className="flex items-center">
      <span className={tile}>
        <FicusLogo className="h-9 w-9" decorative />
      </span>
      <span className="h-px w-4 bg-th-border sm:w-6" />
      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${badge.className}`}>{badge.icon}</span>
      <span className="h-px w-4 bg-th-border sm:w-6" />
      <span className={`${tile} text-primary`}>
        {provider ? (
          <IntegrationLogo provider={provider} label={PROVIDER_LABELS[provider]} />
        ) : (
          <LinkIcon className="h-7 w-7 text-secondary" />
        )}
      </span>
    </div>
  )
}
