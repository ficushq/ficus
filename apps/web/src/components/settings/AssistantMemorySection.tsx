import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries, integrationQueries } from '../../queryOptions'
import { integrationQueryKeys, queryKeys } from '../../queryKeys'
import { setIntegrationEnabled } from '../../api/integrations'
import { useSettingsApi } from './settingsApi'
import { usePermissions } from '../../hooks/usePermissions'
import { IntegrationCredentialSettings } from '../integrations/IntegrationCredentialSettings'
import { FormSkeleton } from '../loading/Skeleton'

/** Feature choices are separate from the shared provider credential. */
export function AssistantMemorySection({ onboarding = false }: { onboarding?: boolean }) {
  const { can } = usePermissions()
  const client = useQueryClient()
  const { setSetting } = useSettingsApi()
  const settings = useQuery({ ...queries.settings.list(), enabled: can('settings:read') })
  const canReadServices = can('integrations:read:openai-services')
  const canWriteServices = can('integrations:write:openai-services')
  const catalog = useQuery({ ...integrationQueries.catalog(), enabled: canReadServices })
  const integration = catalog.data?.integrations.find((item) => item.key === 'openai-services')
  const configured = integration?.setup?.state === 'configured'
  const ready = configured && integration?.enabled === true
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.settings.all }),
      client.invalidateQueries({ queryKey: integrationQueryKeys.all }),
      client.invalidateQueries({ queryKey: queryKeys.voice.all }),
    ])
  }
  const update = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) => setSetting(key, String(enabled)),
    onSuccess: invalidate,
  })
  const enable = useMutation({
    mutationFn: () => setIntegrationEnabled('openai-services', true),
    onSuccess: invalidate,
  })
  const connect = async () => {
    await setIntegrationEnabled('openai-services', true)
    await invalidate()
  }
  const features = [
    {
      key: 'ASSISTANT_REALTIME_ENABLED',
      target: 'realtime-assistant',
      label: 'Voice assistant',
      description: 'Talk with the assistant and hear its responses aloud.',
    },
    {
      key: 'TRANSCRIPTION_ENABLED',
      target: 'voice-dictation',
      label: 'Voice dictation',
      description: 'Record speech as text in chats and question replies.',
    },
    {
      key: 'EMBEDDINGS_ENABLED',
      target: 'automatic-embeddings',
      label: 'Semantic memory search',
      description: onboarding
        ? 'Help agents find relevant information in saved memory.'
        : 'Automatically index memory so agents can find relevant information by meaning. Turning this off stops automatic embedding generation; saved memory is retained.',
    },
  ]
  return (
    <div className="space-y-6" data-setting-target="memory-embeddings">
      <header>
        <h3 className="text-lg font-semibold text-primary">
          {onboarding ? 'Make Ficus your own' : 'Assistant & Memory'}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {onboarding
            ? 'Add voice conversations and help agents find saved knowledge.'
            : 'Choose how the assistant helps you and how agents find saved knowledge.'}
        </p>
      </header>
      {settings.isPending ? (
        <FormSkeleton label="Loading assistant settings" sections={1} />
      ) : settings.isError ? (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Unable to load feature settings.
        </p>
      ) : (
        <div className="divide-y divide-th-border">
          {features.map((feature) => {
            const setting = settings.data?.find((item) => item.key === feature.key)
            if (!setting) return null
            const selected = setting.value === 'true'
            const status = !selected
              ? 'Off'
              : !canReadServices
                ? 'Requires OpenAI API services'
                : catalog.isPending
                  ? 'Checking setup…'
                  : catalog.isError
                    ? 'Setup status unavailable'
                    : ready
                      ? 'Ready'
                      : configured
                        ? 'OpenAI API services are disabled'
                        : 'Needs OpenAI API setup'
            return (
              <div key={feature.key} data-setting-target={feature.target} className="py-4 first:pt-0 space-y-2">
                <label className="flex items-center justify-between gap-4 text-sm font-medium text-primary">
                  {feature.label}
                  <input
                    type="checkbox"
                    role="switch"
                    checked={selected}
                    disabled={!can('settings:write') || update.isPending}
                    onChange={(event) => update.mutate({ key: feature.key, enabled: event.target.checked })}
                  />
                </label>
                <p className="text-sm text-muted">{feature.description}</p>
                <p role="status" className="text-xs text-muted">
                  {status}
                </p>
              </div>
            )
          })}
        </div>
      )}
      {update.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {update.error.message}
        </p>
      )}
      <section className="border-t border-th-border pt-5 space-y-4" data-setting-target="openai-services-setup">
        <div>
          <h4 className="font-medium text-primary">OpenAI API services</h4>
          <p className="mt-1 text-sm text-muted">
            {onboarding
              ? 'These features need an OpenAI API key, separate from a ChatGPT subscription. API usage is billed by OpenAI.'
              : 'Use an OpenAI API key for realtime sessions, dictation, and embeddings. Ficus’s ChatGPT subscription login under AI Providers does not supply this key. These features use your API account and incur API usage charges.'}
          </p>
          {!onboarding && (
            <p className="mt-2 text-xs text-muted">
              This is the same connection used in Integrations. Feature switches above do not change your agent model
              accounts.
            </p>
          )}
        </div>
        {!canReadServices ? (
          <p className="text-sm text-muted">Ask an administrator to configure OpenAI API services.</p>
        ) : ready ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">Connected and enabled.</p>
            <details>
              <summary className="text-sm text-muted cursor-pointer">Manage API key</summary>
              <div className="pt-4">
                <IntegrationCredentialSettings provider="openai-services" kind="service" canWrite={canWriteServices} />
              </div>
            </details>
          </div>
        ) : (
          <div className="space-y-4">
            {configured && (
              <button
                className="ficus-button ficus-button-primary rounded-lg px-3 py-2 text-sm"
                disabled={!canWriteServices || enable.isPending}
                onClick={() => enable.mutate()}
              >
                {enable.isPending ? 'Enabling…' : 'Enable OpenAI API services'}
              </button>
            )}
            <IntegrationCredentialSettings
              provider="openai-services"
              kind="service"
              canWrite={canWriteServices}
              onSaved={connect}
              saveLabel="Save and enable"
              compact={onboarding}
            />
          </div>
        )}
        {enable.isError && (
          <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
            {enable.error.message}
          </p>
        )}
      </section>
    </div>
  )
}
