import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { getClaudeCodeStatus, setClaudeCodeEnabled, type ClaudeCodeStatus } from '../../api/providerAuth'
import { ProviderDirectoryCard } from './ProviderDirectoryCard'

function statusLabel(status: ClaudeCodeStatus) {
  if (!status.enabled) return 'Off'
  if (status.loggedIn) return 'Connected'
  return status.installed ? 'Not signed in' : 'Not installed'
}

/**
 * Agents can use the user's own Claude Code sign-in where Core runs on the user's machine. It is off
 * until the owner turns it on. Ficus only runs `claude` and reads whether it is signed in; signing
 * in happens in Claude Code's own flow, never in Ficus.
 */
export function ClaudeCodeProviderCard({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const { data } = useQuery(queries.providerAuth.claudeCode())
  const applyStatus = (status: ClaudeCodeStatus) => {
    queryClient.setQueryData(queryKeys.providerAuth.claudeCode(), status)
    // Claude Code is an Anthropic account: refresh the provider list and its accounts.
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerAuth.all })
  }
  const check = useMutation({ mutationFn: () => getClaudeCodeStatus(true), onSuccess: applyStatus })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setClaudeCodeEnabled(enabled),
    onSuccess: applyStatus,
  })
  if (!data?.offered) return null

  return (
    <ProviderDirectoryCard
      providerId="anthropic"
      name="Claude Code"
      description="Agents use Claude through Claude Code on this computer, on your own Claude plan. Ficus runs Claude Code and never sees your Claude sign-in."
      status={statusLabel(data)}
    >
      <div className="space-y-3 text-sm text-secondary">
        {data.loggedIn ? (
          <p>
            Claude Code {data.version} is signed in
            {data.subscriptionType ? ` with a Claude ${data.subscriptionType} plan` : ''}.
            {data.enabled
              ? ' Agents use it for Claude models as an Anthropic account, before any Anthropic API key. Reorder or disable it under Anthropic.'
              : ' Turn it on to add it as an Anthropic account, used for Claude models before any Anthropic API key.'}
          </p>
        ) : data.installed ? (
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
          Requests count against your Claude plan’s usage limits, and Anthropic may bill some to extra usage. Use it for
          your own agents only.
        </p>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <button
              type="button"
              role="switch"
              aria-checked={data.enabled}
              className="ficus-button text-sm text-primary"
              onClick={() => toggle.mutate(!data.enabled)}
              disabled={toggle.isPending}
            >
              {toggle.isPending ? 'Saving…' : data.enabled ? 'Turn off' : 'Turn on'}
            </button>
          )}
          <button
            type="button"
            className="ficus-button text-sm text-primary"
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            {check.isPending ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </ProviderDirectoryCard>
  )
}
