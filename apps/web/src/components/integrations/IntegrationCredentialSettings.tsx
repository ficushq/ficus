import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  configureChannelIntegration,
  configureDeploymentIntegration,
  configureServiceIntegration,
} from '../../api/integrations'
import { integrationQueries } from '../../queryOptions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'

export function IntegrationCredentialSettings({
  provider,
  canWrite,
  kind = 'channel',
  onSaved,
  saveLabel,
  compact = false,
  hideManagedFields = false,
}: {
  provider: string
  canWrite: boolean
  kind?: 'channel' | 'deployment' | 'service'
  onSaved?: () => Promise<void>
  saveLabel?: string
  compact?: boolean
  hideManagedFields?: boolean
}) {
  const fieldId = useId()
  const client = useQueryClient()
  const config = useQuery(integrationQueries.credentialSettings(provider, kind))
  const [draft, setDraft] = useState<Record<string, string | null>>({})
  const save = useMutation({
    mutationFn: async () => {
      await (
        kind === 'service'
          ? configureServiceIntegration
          : kind === 'deployment'
            ? configureDeploymentIntegration
            : configureChannelIntegration
      )(provider, draft)
      await onSaved?.()
    },
    onSuccess: async () => {
      setDraft({})
      await Promise.all([
        client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
        client.invalidateQueries({ queryKey: queryKeys.voice.all }),
      ])
    },
  })
  return (
    <div className="space-y-6">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        {!compact && <h4 className="font-medium text-primary">Credentials</h4>}
        {!compact && (
          <p className="text-xs text-muted">
            Saved secrets stay hidden. Leave a field unchanged to keep its saved value.
          </p>
        )}
        {config.isPending ? (
          <p>Loading credentials…</p>
        ) : config.isError ? (
          <p role="alert">Unable to load integration settings.</p>
        ) : (
          config.data.fields
            .filter((field) => !hideManagedFields || !field.managed)
            .map((field) => {
              const missing =
                field.required && !field.managed && !field.configured && !(draft[field.key] ?? field.value ?? '').trim()
              const hintId = `${fieldId}-${field.key}-hint`
              return (
                <div key={field.key} className="space-y-1 text-sm">
                  <label htmlFor={`${fieldId}-${field.key}`} className="block">
                    {field.label}
                    {field.required && <span className="ml-1 text-xs text-muted">(required)</span>}
                    {(field.managed || field.configured) && (
                      <span className="ml-2 text-xs text-muted">
                        {field.managed ? 'Managed by your platform' : 'Configured'}
                      </span>
                    )}
                  </label>
                  {field.multiline ? (
                    <textarea
                      id={`${fieldId}-${field.key}`}
                      className="ficus-field min-h-40 w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 font-mono text-xs text-primary"
                      rows={6}
                      required={field.required && !field.configured && !field.managed}
                      aria-required={field.required}
                      aria-invalid={missing || undefined}
                      aria-describedby={missing ? hintId : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      value={draft[field.key] ?? field.value ?? ''}
                      placeholder={
                        field.secret && field.configured
                          ? 'Paste a replacement to change the saved credential'
                          : field.placeholder
                      }
                      disabled={!canWrite || field.managed || save.isPending}
                      onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                    />
                  ) : (
                    <input
                      id={`${fieldId}-${field.key}`}
                      className="ficus-field w-full rounded-md border border-panel-border bg-surface-secondary px-3 py-2 text-primary"
                      type={field.secret ? 'password' : 'text'}
                      required={field.required && !field.configured && !field.managed}
                      aria-required={field.required}
                      aria-invalid={missing || undefined}
                      aria-describedby={missing ? hintId : undefined}
                      autoComplete="off"
                      value={draft[field.key] ?? field.value ?? ''}
                      placeholder={
                        field.secret && field.configured ? 'Enter a replacement to change' : field.placeholder
                      }
                      disabled={!canWrite || field.managed || save.isPending}
                      onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                    />
                  )}
                  {missing && (
                    <span
                      id={hintId}
                      className="block text-xs text-status-attention-600 dark:text-status-attention-400"
                    >
                      {field.label} is required.
                    </span>
                  )}
                </div>
              )
            })
        )}
        {canWrite && (
          <button
            className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm disabled:opacity-50"
            disabled={save.isPending || config.isError || !Object.keys(draft).length}
          >
            {saveLabel ?? (provider === 'web-push' ? 'Save' : 'Save credentials')}
          </button>
        )}
        {save.isError && (
          <p role="alert" className="text-sm text-danger">
            {save.error.message}
          </p>
        )}
        {save.isSuccess && (
          <p role="status" className="text-sm text-muted">
            Credentials saved.
          </p>
        )}
      </form>
    </div>
  )
}
