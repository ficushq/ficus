import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { configureGitHubWebhook } from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys } from '../../queryKeys'

export function GitHubWebhookSettings({ canWrite, managed }: { canWrite: boolean; managed: boolean }) {
  const client = useQueryClient()
  const settings = useQuery(integrationQueries.githubWebhook())
  const [secret, setSecret] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!canWrite) setSecret('')
  }, [canWrite])
  const save = useMutation({
    mutationFn: (value: string | null) => configureGitHubWebhook(value),
    onSuccess: (result) => {
      client.setQueryData(integrationQueryKeys.githubWebhook(), result)
      setNotice(result.configured ? 'Webhook secret saved.' : 'Direct webhooks disabled. Polling remains available.')
    },
    onSettled: () => setSecret(''),
  })
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-xs text-muted">Webhook delivery</summary>
      <div className="mt-3 space-y-3 text-xs text-muted">
        <p>
          {managed
            ? 'The shared GitHub App can deliver events through your platform when its webhook relay is configured. You can also configure direct delivery below.'
            : 'Polling is automatic. For immediate events, configure your own GitHub App or a repository webhook to deliver directly to Ficus.'}
        </p>
        {settings.data && (
          <>
            <p>
              Webhook URL: <span className="break-all select-all font-mono">{settings.data.webhookUrl}</span>
            </p>
            <p>
              {settings.data.configured ? 'Direct webhook secret configured.' : 'Direct webhooks are not configured.'}
            </p>
          </>
        )}
        {canWrite && settings.data && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (secret.trim()) save.mutate(secret)
            }}
          >
            <p>
              Use the same secret in GitHub and here. Saved secrets cannot be revealed; generate or enter a new one to
              rotate it.
            </p>
            <label className="block text-sm text-primary">
              Webhook secret
              <input
                className="ficus-field mt-1 block h-10 w-full px-3 py-2 text-sm"
                placeholder={
                  settings.data.configured
                    ? 'Enter a new secret to replace the saved one'
                    : 'Enter or generate a webhook secret'
                }
                aria-label="GitHub webhook secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                maxLength={16_384}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="ficus-button"
                disabled={save.isPending}
                onClick={() => {
                  setSecret(
                    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
                      byte.toString(16).padStart(2, '0')
                    ).join('')
                  )
                  setNotice('Copy this new secret to GitHub before saving it here.')
                }}
              >
                Generate secret
              </button>
              <button
                type="button"
                className="ficus-button"
                disabled={!secret || save.isPending}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret)
                    setNotice('Copied. Paste it into GitHub’s webhook secret field, then save here.')
                  } catch {
                    setNotice('Unable to copy. Enter the same secret in GitHub and here.')
                  }
                }}
              >
                Copy new secret
              </button>
              <button className="ficus-button" disabled={!secret.trim() || save.isPending}>
                {settings.data.configured ? 'Save webhook secret' : 'Enable direct webhooks'}
              </button>
              {settings.data.configured && (
                <button
                  type="button"
                  className="ficus-button"
                  disabled={save.isPending}
                  onClick={() => save.mutate(null)}
                >
                  Disable direct webhooks
                </button>
              )}
            </div>
          </form>
        )}
        {settings.isPending && <p role="status">Loading webhook settings…</p>}
        {notice && <p role="status">{notice}</p>}
        {(settings.isError || save.isError) && (
          <p role="alert">Unable to load or save GitHub webhook settings. Please try again.</p>
        )}
      </div>
    </details>
  )
}
