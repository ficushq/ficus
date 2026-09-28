import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../queryKeys'
import { getClaudeCodeStatus, setClaudeCodeEnabled, type ClaudeCodeStatus } from '../../api/providerAuth'

/**
 * Connect the user's own Claude Code as an Anthropic account. Ficus only runs `claude` and reads
 * whether it is signed in; signing in happens in Claude Code's own flow, never in Ficus.
 */
export function ClaudeCodeAccountSetup({
  status,
  onDone,
  onCancel,
}: {
  status: ClaudeCodeStatus
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const apply = (next: ClaudeCodeStatus) => {
    queryClient.setQueryData(queryKeys.providerAuth.claudeCode(), next)
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerAuth.all })
  }
  const check = useMutation({ mutationFn: () => getClaudeCodeStatus(true), onSuccess: apply })
  const enable = useMutation({
    mutationFn: () => setClaudeCodeEnabled(true),
    onSuccess: (next) => {
      apply(next)
      onDone()
    },
  })

  return (
    <div className="space-y-3 text-sm text-secondary">
      {status.loggedIn ? (
        <p>
          Claude Code {status.version}
          {status.path ? (
            <>
              {' '}
              (<code className="font-mono text-primary">{status.path}</code>)
            </>
          ) : null}{' '}
          is signed in
          {status.subscriptionType ? ` with a Claude ${status.subscriptionType} plan` : ''}. It becomes the first
          Anthropic account, so Claude models use your plan before any API key.
        </p>
      ) : status.installed ? (
        <p>
          Sign in with Claude Code’s own login in a terminal:{' '}
          <code className="font-mono text-primary">claude auth login</code>. Then check again.
        </p>
      ) : (
        <p>
          Install Claude Code (
          <a
            className="text-accent-light underline"
            href="https://code.claude.com/docs/en/setup"
            target="_blank"
            rel="noreferrer"
          >
            setup guide
          </a>
          ), sign in with <code className="font-mono text-primary">claude auth login</code>, then check again.
        </p>
      )}
      <p className="text-xs text-muted">
        Ficus runs Claude Code on this computer and never sees your Claude sign-in. Requests count against your Claude
        plan’s usage limits, and Anthropic may bill some to extra usage. Use it for your own agents only.
      </p>
      {enable.isError && (
        <p role="alert" className="text-sm text-danger">
          {enable.error instanceof Error && enable.error.message
            ? enable.error.message
            : 'Could not turn on Claude Code'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {status.loggedIn ? (
          <button
            type="button"
            onClick={() => enable.mutate()}
            disabled={enable.isPending}
            className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {enable.isPending ? 'Connecting…' : 'Use Claude Code'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending}
            className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {check.isPending ? 'Checking…' : 'Check again'}
          </button>
        )}
        <button type="button" onClick={onCancel} className="ficus-button text-sm text-muted hover:text-primary">
          Cancel
        </button>
      </div>
    </div>
  )
}
