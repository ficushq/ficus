import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { updateSquad } from '../../api/squads'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import clsx from 'clsx'
import { FormSkeleton } from '../loading/Skeleton'

interface Props {
  squadId: string
}

interface ChannelConfig {
  instanceId: string
  channelId: string
}

interface NotificationConfig {
  discord?: ChannelConfig
  slack?: ChannelConfig
  telegram?: ChannelConfig
}

const PROVIDERS = [
  { key: 'discord', label: 'Discord', emoji: '🎮', idLabel: 'Channel ID' },
  { key: 'slack', label: 'Slack', emoji: '💬', idLabel: 'Channel ID' },
  { key: 'telegram', label: 'Telegram', emoji: '📱', idLabel: 'Chat ID' },
] as const

type ProviderKey = (typeof PROVIDERS)[number]['key']

export function NotificationSettings({ squadId }: Props) {
  const queryClient = useQueryClient()

  // Fetch squad and channel instances
  const { data: squad, isLoading: squadLoading } = useQuery(queries.squads.basic(squadId))
  const { data: instances, isLoading: instancesLoading } = useQuery(queries.channelInstances.all())

  // Form state - initialize from current config
  const [config, setConfig] = useState<NotificationConfig>({})
  const [hasChanges, setHasChanges] = useState(false)

  // Reset form when squad data loads
  useEffect(() => {
    if (squad) {
      const notifications = (squad.metadata as { notifications?: NotificationConfig } | undefined)?.notifications || {}
      setConfig(notifications)
      setHasChanges(false)
    }
  }, [squad])

  // Validation: check for incomplete configs (has instanceId but no channelId)
  const validationErrors = useMemo(() => {
    const errors: Record<ProviderKey, string | null> = {
      discord: null,
      slack: null,
      telegram: null,
    }

    for (const provider of PROVIDERS) {
      const cfg = config[provider.key as keyof NotificationConfig]
      if (cfg?.instanceId) {
        const channelId = cfg.channelId
        if (!channelId?.trim()) {
          errors[provider.key] = `${provider.idLabel} is required`
        }
      }
    }

    return errors
  }, [config])

  const hasValidationErrors = Object.values(validationErrors).some((e) => e !== null)

  // Update mutation - only sends changed fields, backend does deep merge
  const updateMutation = useMutation({
    mutationFn: async (notifications: NotificationConfig) => {
      return updateSquad(squadId, {
        metadata: { notifications },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.basic(squadId) })
      setHasChanges(false)
    },
  })

  const handleSave = () => {
    if (hasValidationErrors) return

    // Build clean config, set cleared providers to null for deletion
    const toSave: Record<string, unknown> = {}

    for (const provider of PROVIDERS) {
      const cfg = config[provider.key as keyof NotificationConfig]

      if (cfg?.instanceId && cfg.channelId?.trim()) {
        // Valid config - include it
        toSave[provider.key] = cfg
      } else if (!cfg?.instanceId) {
        // No instance selected - set to null to clear (if it was previously set)
        const original = (squad?.metadata as { notifications?: NotificationConfig } | undefined)?.notifications
        if (original?.[provider.key as keyof NotificationConfig]) {
          toSave[provider.key] = null
        }
      }
    }

    updateMutation.mutate(toSave as NotificationConfig)
  }

  const updateProvider = (provider: string, field: string, value: string) => {
    setConfig((prev) => {
      const current = (prev[provider as keyof NotificationConfig] as ChannelConfig) || {
        instanceId: '',
        channelId: '',
      }
      return {
        ...prev,
        [provider]: { ...current, [field]: value },
      }
    })
    setHasChanges(true)
  }

  const clearProvider = (provider: string) => {
    setConfig((prev) => {
      const newConfig = { ...prev }
      delete newConfig[provider as keyof NotificationConfig]
      return newConfig
    })
    setHasChanges(true)
  }

  if (squadLoading || instancesLoading) {
    return <FormSkeleton label="Loading notification settings" sections={3} />
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 data-setting-target="notification-channels" className="text-sm font-medium text-primary">
            Notification Channels
          </h3>
          <p className="text-xs text-muted mt-1">Configure where to send notifications for work stream events.</p>
        </div>
        {hasChanges && (
          <button
            onClick={handleSave}
            disabled={updateMutation.isPending || hasValidationErrors}
            className={clsx(
              'ficus-button',
              'px-3 py-1.5 text-sm rounded-md',
              hasValidationErrors
                ? 'bg-surface-secondary text-muted cursor-not-allowed'
                : 'bg-accent text-on-accent hover:bg-accent/90'
            )}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
          </button>
        )}
      </div>

      <div className="space-y-3">
        {PROVIDERS.map((provider) => {
          const providerInstances = instances?.filter((i) => i.provider === provider.key) || []
          const cfg = config[provider.key as keyof NotificationConfig]
          const currentId = cfg?.channelId || ''
          const error = validationErrors[provider.key]

          return (
            <div
              key={provider.key}
              className={clsx('py-4 border-b last:border-b-0', error ? 'border-status-danger-500' : 'border-th-border')}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{provider.emoji}</span>
                  <span className="text-sm font-medium text-primary">{provider.label}</span>
                </div>
                {cfg?.instanceId && (
                  <button
                    onClick={() => clearProvider(provider.key)}
                    className="ficus-button text-xs text-muted hover:text-status-danger-500"
                  >
                    Clear
                  </button>
                )}
              </div>

              {providerInstances.length === 0 ? (
                <p className="text-xs text-muted">No {provider.label} channel instances configured.</p>
              ) : (
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-muted block mb-1">Instance</label>
                    <select
                      value={cfg?.instanceId || ''}
                      onChange={(e) => updateProvider(provider.key, 'instanceId', e.target.value)}
                      className="ficus-field w-full px-2 py-1.5 text-sm rounded border border-th-border bg-surface text-primary  focus:ring-1 focus:ring-accent/50"
                    >
                      <option value="">Select instance...</option>
                      {providerInstances.map((inst) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {cfg?.instanceId && (
                    <div>
                      <label className={clsx('text-xs block mb-1', error ? 'text-status-danger-500' : 'text-muted')}>
                        {provider.idLabel} {error && <span className="font-normal">— {error}</span>}
                      </label>
                      <input
                        type="text"
                        value={currentId}
                        onChange={(e) => updateProvider(provider.key, 'channelId', e.target.value)}
                        placeholder={`Enter ${provider.idLabel.toLowerCase()}`}
                        className={clsx(
                          'ficus-field',
                          'w-full px-2 py-1.5 text-sm rounded border bg-surface text-primary  focus:ring-1',
                          error
                            ? 'border-status-danger-500 focus:ring-status-danger-500/50'
                            : 'border-th-border focus:ring-accent/50'
                        )}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {updateMutation.isError && (
        <p className="text-xs text-status-danger-500 mt-2">Failed to save: {String(updateMutation.error)}</p>
      )}
    </div>
  )
}
