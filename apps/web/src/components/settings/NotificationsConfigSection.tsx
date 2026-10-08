import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { usePermissions } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  updateNotificationConfig,
  revertNotificationConfig,
  revertNotificationConfigFields,
  exportNotificationConfigYaml,
} from '../../api/config'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'
import { FormSkeleton } from '../loading/Skeleton'
import { DesktopNotificationsSetting } from './DesktopNotificationsSetting'

const EVENTS: Record<string, { label: string; description: string }> = {
  'agent-question.created': { label: 'An agent needs an answer', description: 'A question is ready for your input.' },
  'workStream.blocked': { label: 'Work is blocked', description: 'A work stream cannot make progress.' },
  'workStream.review': { label: 'Work is ready for review', description: 'A work stream is waiting for review.' },
  'workStream.done': { label: 'Work is finished', description: 'A work stream has completed.' },
  'workStream.canceled': { label: 'Work is canceled', description: 'A work stream has been canceled.' },
  'workStream.created': { label: 'New work is created', description: 'A work stream has been added.' },
  'workStream.updated': { label: 'Work is updated', description: 'A work stream’s details change.' },
  'inbox.messageReceived': { label: 'An inbox message arrives', description: 'A new message reaches an inbox.' },
  'execution.completed': {
    label: 'An agent finishes a turn',
    description: 'An individual agent turn completes, even if its work is ongoing.',
  },
  'execution.failed': {
    label: 'An agent encounters an error',
    description: 'An agent turn fails and may need attention.',
  },
}
const CHANNELS: Record<string, string> = {
  push: 'Push notifications',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  console: 'Server log',
}

interface NotificationRule {
  id?: string
  event: string
  channels: string[]
  match?: Record<string, unknown>
}

interface ChannelConfig {
  enabled: boolean
}

export function NotificationsConfigSection() {
  const queryClient = useQueryClient()
  const { can } = usePermissions()
  const canWrite = can('settings:write')
  const { data: config, isLoading } = useQuery(queries.notificationConfig.detail())
  const [showDiff, setShowDiff] = useState(false)
  const [copyMsg, setCopyMsg] = useState('')

  const [rules, setRules] = useState<NotificationRule[] | null>(null)
  const [channels, setChannels] = useState<Record<string, ChannelConfig> | null>(null)

  const currentRules: NotificationRule[] = rules ?? (config?.rules as NotificationRule[]) ?? []
  const currentChannels: Record<string, ChannelConfig> =
    channels ?? (config?.channels as Record<string, ChannelConfig>) ?? {}

  const diffQuery = useQuery({
    ...queries.notificationConfig.templateDiff(),
    enabled: showDiff || !!config?.hasTemplate,
  })

  const updateMutation = useMutation({
    mutationFn: (data: { rules: unknown[]; channels: Record<string, unknown> }) => updateNotificationConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.all })
      setRules(null)
      setChannels(null)
    },
  })

  const createMutation = useMutation({
    mutationFn: () => updateNotificationConfig({ rules: [], channels: {} }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.all })
    },
  })

  const revertMutation = useMutation({
    mutationFn: () => revertNotificationConfig(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.all })
      setShowDiff(false)
      setRules(null)
      setChannels(null)
    },
  })

  const revertFieldsMutation = useMutation({
    mutationFn: (fields: string[]) => revertNotificationConfigFields(fields),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationConfig.templateDiff() })
      setRules(null)
      setChannels(null)
    },
  })

  const notificationFieldActions = (field: string) => (
    <TemplateFieldActions
      field={field}
      current={diffQuery.data?.current ?? null}
      template={diffQuery.data?.template ?? null}
      fieldOverrides={diffQuery.data?.fieldOverrides ?? config?.yamlFieldOverrides ?? []}
      onRevert={(field) => revertFieldsMutation.mutate([field])}
      isReverting={revertFieldsMutation.isPending}
    />
  )

  const canonicalMatch = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalMatch).join(',')}]`
    if (value !== null && typeof value === 'object')
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalMatch(item)}`)
        .join(',')}}`
    return JSON.stringify(value)
  }
  const ruleTemplateKey = (rule: NotificationRule) =>
    rule.id ?? `${rule.event ?? '*'}:${canonicalMatch(rule.match ?? {})}`

  const handleSave = () => {
    updateMutation.mutate({ rules: currentRules, channels: currentChannels })
  }

  const handleExport = async () => {
    try {
      const yaml = await exportNotificationConfigYaml()
      await navigator.clipboard.writeText(yaml)
      setCopyMsg('Copied!')
      setTimeout(() => setCopyMsg(''), 2000)
    } catch {
      setCopyMsg('Failed')
      setTimeout(() => setCopyMsg(''), 2000)
    }
  }

  // Channel toggle
  const toggleChannel = (ch: string) => {
    const updated = { ...currentChannels }
    if (updated[ch]) {
      updated[ch] = { ...updated[ch], enabled: !updated[ch].enabled }
    } else {
      updated[ch] = { enabled: true }
    }
    setChannels(updated)
  }

  // Rule channel toggle
  const toggleRuleChannel = (ruleIndex: number, ch: string) => {
    const updated = [...currentRules]
    const rule = { ...updated[ruleIndex] }
    if (rule.channels.includes(ch)) {
      rule.channels = rule.channels.filter((c) => c !== ch)
    } else {
      rule.channels = [...rule.channels, ch]
    }
    updated[ruleIndex] = rule
    setRules(updated)
  }

  // Add rule for an event
  const addRule = (event: string) => {
    setRules([...currentRules, { event, channels: [] }])
  }

  // Remove a rule
  const removeRule = (index: number) => {
    setRules(currentRules.filter((_, i) => i !== index))
  }

  // Events that don't have a rule yet
  const unusedEvents = useMemo(
    () => Object.keys(EVENTS).filter((e) => !currentRules.some((r) => r.event === e)),
    [currentRules]
  )

  const availableChannels = Array.from(
    new Set([
      ...Object.keys(CHANNELS),
      ...Object.keys(currentChannels),
      ...currentRules.flatMap((rule) => rule.channels),
    ])
  )
  const dirty = rules !== null || channels !== null

  if (isLoading) {
    return <FormSkeleton label="Loading notification configuration" sections={4} />
  }

  if (!config) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold text-primary">Notification Rules</h3>
          <p className="text-sm text-muted mt-1">No notification configuration found.</p>
        </div>
        <DesktopNotificationsSetting />
        <button
          onClick={() => createMutation.mutate()}
          disabled={!canWrite || createMutation.isPending}
          className="ficus-button ficus-button-primary px-4 py-2 text-sm rounded-md disabled:opacity-50 font-medium"
        >
          {createMutation.isPending ? 'Creating…' : 'Set up notifications'}
        </button>
        {createMutation.isError && (
          <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
            {(createMutation.error as Error).message}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Notification Rules</h3>
        <p className="text-sm text-muted mt-1">Decide which updates Ficus sends to people across your workspace.</p>
      </div>
      <DesktopNotificationsSetting />

      {config.disabled && (
        <p role="status" className="text-sm text-warning">
          Notification rules are disabled.
        </p>
      )}
      <fieldset disabled={!canWrite || updateMutation.isPending} className="space-y-8">
        <section data-setting-target="channels" className="space-y-3">
          <h4 className="font-medium text-primary">Where to send notifications</h4>
          <p className="text-sm text-muted">
            Choose which destinations these rules can use. Connect apps in{' '}
            <Link className="text-accent-light" to="/settings?section=integrations">
              Integrations
            </Link>{' '}
            and choose each squad’s channels in its settings.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {availableChannels.map((channel) => (
              <label key={channel} className="flex items-center gap-2 text-sm text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={currentChannels[channel]?.enabled ?? false}
                  onChange={() => toggleChannel(channel)}
                />
                {CHANNELS[channel] ?? channel}
              </label>
            ))}
          </div>
        </section>
        <section data-setting-target="rules" className="space-y-4">
          <div>
            <h4 className="font-medium text-primary">When to notify</h4>
            <p className="mt-1 text-sm text-muted">
              Choose destinations for each situation. Personal notification preferences still apply.
            </p>
          </div>
          {!currentRules.length && (
            <p className="py-4 text-sm text-muted">No rules yet. Choose a situation below to get started.</p>
          )}
          <div className="divide-y divide-th-border">
            {currentRules.map((rule, index) => {
              const event = EVENTS[rule.event]
              const label =
                rule.match?.source === 'fleet-alert' ? 'The fleet needs attention' : (event?.label ?? rule.event)
              const personalInbox =
                Array.isArray(rule.match?.recipientType) && rule.match.recipientType.join(',') === 'user,system'
              return (
                <article key={`${rule.id ?? rule.event}-${index}`} className="py-5 first:pt-0 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h5 className="text-sm font-medium text-primary">{label}</h5>
                      <p className="mt-1 text-sm text-muted">
                        {rule.match?.source === 'fleet-alert'
                          ? 'An operational issue needs a human’s attention.'
                          : personalInbox
                            ? 'A message arrives in a personal or shared system inbox.'
                            : event?.description}
                      </p>
                    </div>
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => removeRule(index)}
                        aria-label={`Remove rule: ${label}`}
                        className="ficus-button ficus-button-danger px-2 py-1 text-xs"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {availableChannels.map((channel) => {
                      const enabled = currentChannels[channel]?.enabled ?? false
                      return (
                        <label key={channel} className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                          <input
                            type="checkbox"
                            aria-label={`${label}: ${CHANNELS[channel] ?? channel}`}
                            checked={rule.channels.includes(channel)}
                            onChange={() => toggleRuleChannel(index, channel)}
                          />
                          {CHANNELS[channel] ?? channel}
                          {!enabled && <span className="text-xs text-muted">(off)</span>}
                        </label>
                      )
                    })}
                  </div>
                  {!rule.channels.some((channel) => currentChannels[channel]?.enabled) && (
                    <p className="text-xs text-muted">This rule has no active destinations.</p>
                  )}
                  {rule.match && !personalInbox && rule.match.source !== 'fleet-alert' && (
                    <p className="text-xs text-muted">Applies only when the saved conditions match.</p>
                  )}
                </article>
              )
            })}
          </div>
          {canWrite && unusedEvents.length > 0 && (
            <select
              aria-label="Add notification rule"
              value=""
              onChange={(event) => {
                if (event.target.value) addRule(event.target.value)
              }}
              className="ficus-field w-full sm:w-auto rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Add a notification rule…</option>
              {unusedEvents.map((event) => (
                <option key={event} value={event}>
                  {EVENTS[event].label}
                </option>
              ))}
            </select>
          )}
        </section>
        {canWrite && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={!dirty || updateMutation.isPending}
              className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm"
            >
              {updateMutation.isPending ? 'Saving…' : 'Save changes'}
            </button>
            {dirty && (
              <button
                onClick={() => {
                  setRules(null)
                  setChannels(null)
                }}
                className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
              >
                Discard changes
              </button>
            )}
            {!dirty && updateMutation.isSuccess && (
              <span role="status" className="text-sm text-muted">
                Saved
              </span>
            )}
          </div>
        )}
      </fieldset>
      {updateMutation.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {updateMutation.error.message}
        </p>
      )}
      {!canWrite && <p className="text-sm text-muted">You have read-only access to notification rules.</p>}
      <details className="border-t border-th-border pt-5">
        <summary className="cursor-pointer text-sm text-muted">Advanced: templates and event details</summary>
        <p className="mt-3 text-xs text-muted">
          Rules are evaluated in order; the first match wins. Existing conditions are preserved when you change
          destinations.
        </p>
        <div className="my-4 flex flex-wrap items-center gap-4">
          {config.yamlFieldOverrides.length > 0 && (
            <button onClick={() => setShowDiff(true)} className="ficus-button ficus-button-link text-sm">
              Compare to template
            </button>
          )}
          <button onClick={handleExport} className="ficus-button ficus-button-link text-sm">
            {copyMsg || 'Export YAML'}
          </button>
        </div>
        <div className="space-y-3">
          {currentRules.map((rule, index) => (
            <div key={index} className="text-xs text-muted">
              <div className="flex items-center gap-2">
                <code>{rule.event}</code>
                {canWrite && notificationFieldActions(`rules.${ruleTemplateKey(rule)}`)}
              </div>
              {rule.match && (
                <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(rule.match, null, 2)}</pre>
              )}
            </div>
          ))}
          {canWrite &&
            availableChannels.map((channel) => (
              <div key={channel} className="flex items-center gap-2 text-xs text-muted">
                {CHANNELS[channel] ?? channel}
                {notificationFieldActions(`channels.${channel}`)}
              </div>
            ))}
        </div>
      </details>

      <TemplateDiffDialog
        isOpen={showDiff}
        onClose={() => setShowDiff(false)}
        title="Notification Config — Template Diff"
        current={diffQuery.data?.current ?? null}
        template={diffQuery.data?.template ?? null}
        onRevert={() => canWrite && revertMutation.mutate()}
        onRevertFields={(fields) => canWrite && revertFieldsMutation.mutate(fields)}
        fieldOverrides={diffQuery.data?.fieldOverrides ?? []}
        isReverting={revertMutation.isPending || revertFieldsMutation.isPending}
      />
    </div>
  )
}
