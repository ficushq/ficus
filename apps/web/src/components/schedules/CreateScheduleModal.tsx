import { WorkflowPicker } from '../squads/WorkflowPicker'
import { WorkflowEditorModal } from '../squads/WorkflowEditorModal'
import { isWorkerAgentType, type WorkflowDefinition, type WorkflowSource } from '@ficus/shared'
import { useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { schedulesApi } from '../../api/schedules'
import { queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { Modal } from '../Modal'
import { ClipboardIcon, WarningIcon } from '../icons'
import type { ScheduleScopeType, ScheduleAction, CreateScheduleInput, WebhookEnableResult } from '@ficus/shared'

type ScheduleActionType = ScheduleAction['type']

interface Props {
  isOpen: boolean
  onClose: () => void
  defaultScope?: { type: ScheduleScopeType; id: string }
}

type ScheduleType = 'interval' | 'cron' | 'runAt' | 'webhookOnly'

export function buildCreateScheduleConfig(input: {
  scheduleType: ScheduleType
  interval: string
  cron: string
  runAt: string
  expiresAt: string
  actionCreatesWorkStream: boolean
  skipIfUnresolved: boolean
}): CreateScheduleInput['schedule'] {
  const config: CreateScheduleInput['schedule'] = {}
  if (input.scheduleType === 'interval') config.interval = input.interval
  if (input.scheduleType === 'cron') config.cron = input.cron
  if (input.scheduleType === 'runAt') config.runAt = new Date(input.runAt).toISOString()
  if (input.expiresAt) config.expiresAt = new Date(input.expiresAt).toISOString()
  if (input.actionCreatesWorkStream) config.skipIfUnresolved = input.skipIfUnresolved
  return config
}

export function CreateScheduleModal({ isOpen, onClose, defaultScope }: Props) {
  const queryClient = useQueryClient()

  // Form state
  const [name, setName] = useState('')
  const [scopeType, setScopeType] = useState<ScheduleScopeType>(defaultScope?.type || 'squad')
  const [scopeId, setScopeId] = useState(defaultScope?.id || '')
  const [scheduleType, setScheduleType] = useState<ScheduleType>('interval')
  const [interval, setInterval] = useState('1h')
  const [cron, setCron] = useState('0 9 * * *')
  const [runAt, setRunAt] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [actionType, setActionType] = useState<ScheduleActionType>('inbox_message')

  // Action-specific state
  const [targetAgentId, setTargetAgentId] = useState('')
  const [targetManager, setTargetManager] = useState(false)
  const [subject, setSubject] = useState('')
  const [content, setContent] = useState('')
  const [agentTypeId, setAgentTypeId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workflow, setWorkflow] = useState<WorkflowSource>()
  // A fresh `session` remounts the editor so each open starts from its own draft.
  const [flowEditor, setFlowEditor] = useState<{ session: number; initial?: WorkflowDefinition } | null>(null)
  const [wsTitle, setWsTitle] = useState('')
  const [wsDescription, setWsDescription] = useState('')
  const [skipIfUnresolved, setSkipIfUnresolved] = useState(true)

  // State for showing webhook token after creation
  const [webhookResult, setWebhookResult] = useState<WebhookEnableResult | null>(null)
  const [copied, setCopied] = useState(false)

  // Fetch squads for scope selection
  const { data: squads } = useQuery(queries.squads.list())

  // Fetch agent types for spawn_agent action
  const { data: agentTypes } = useQuery(queries.agentTypes.list())

  const createMutation = useMutation({
    mutationFn: async (input: CreateScheduleInput) => {
      const schedule = await schedulesApi.create(input)
      // For webhook-only schedules, enable webhook and return both
      if (input.webhookOnly) {
        const webhookResult = await schedulesApi.enableWebhook(schedule.id)
        return { schedule, webhookResult }
      }
      return { schedule, webhookResult: null }
    },
    onSuccess: ({ webhookResult: result }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all })
      if (result) {
        // Show webhook token before closing
        setWebhookResult(result)
      } else {
        onClose()
      }
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const isWebhookOnly = scheduleType === 'webhookOnly'
    const actionCreatesWorkStream = Boolean(actionType === 'create_work_stream')
    const scheduleConfig = buildCreateScheduleConfig({
      scheduleType,
      interval,
      cron,
      runAt,
      expiresAt,
      actionCreatesWorkStream,
      skipIfUnresolved,
    })

    let action: CreateScheduleInput['action']
    switch (actionType) {
      case 'inbox_message':
        action = {
          type: 'inbox_message',
          target: targetManager ? { type: 'squad_manager' } : { type: 'agent', agentId: targetAgentId },
          subject: subject || undefined,
          content,
        }
        break
      case 'spawn_agent':
        action = {
          type: 'spawn_agent',
          agentTypeId,
          prompt,
        }
        break
      case 'create_work_stream':
        action = {
          type: 'create_work_stream',
          title: wsTitle,
          ...(workflow ? { workflow } : {}),
          description: wsDescription || undefined,
        }
        break
      default:
        return // Unknown action type, don't submit
    }

    createMutation.mutate({
      scopeType,
      scopeId,
      name,
      enabled: true,
      schedule: scheduleConfig,
      action,
      webhookOnly: isWebhookOnly || undefined,
    })
  }

  const isSquadScope = scopeType === 'squad'

  // Helper to copy text to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // If we have a webhook result, show token screen instead of form
  if (webhookResult) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Webhook Schedule Created">
        <div className="space-y-4">
          <div className="bg-status-success-50 dark:bg-status-success-900/20 border border-status-success-200 dark:border-status-success-800 rounded p-3">
            <p className="text-sm text-status-success-700 dark:text-status-success-300 font-medium">
              ✓ Webhook-only schedule created successfully!
            </p>
          </div>

          <div className="bg-status-review-50 dark:bg-status-review-900/20 border border-status-review-200 dark:border-status-review-800 rounded p-3 space-y-2">
            <p className="flex items-center gap-1.5 text-sm text-status-review-700 dark:text-status-review-300 font-medium">
              <WarningIcon className="h-4 w-4 shrink-0" /> Save this token - it will not be shown again!
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-surface px-2 py-1.5 rounded border border-status-review-200 dark:border-status-review-800 text-primary overflow-x-auto">
                {webhookResult.token}
              </code>
              <button
                onClick={() => copyToClipboard(webhookResult.token)}
                className="ficus-button p-1.5 text-muted hover:text-primary bg-surface rounded border border-status-review-200 dark:border-status-review-800"
                title="Copy token"
              >
                <ClipboardIcon className="w-4 h-4" />
              </button>
            </div>
            {copied && <p className="text-xs text-status-success-600 dark:text-status-success-400">Copied!</p>}
          </div>

          <div>
            <label className="text-sm font-medium text-primary">Webhook URL:</label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 text-xs font-mono bg-surface-secondary px-2 py-1.5 rounded border border-th-border text-secondary overflow-x-auto">
                {webhookResult.webhookUrl}
              </code>
              <button
                onClick={() => copyToClipboard(webhookResult.webhookUrl)}
                className="ficus-button p-1.5 text-muted hover:text-primary bg-surface-secondary rounded border border-th-border"
                title="Copy URL"
              >
                <ClipboardIcon className="w-4 h-4" />
              </button>
            </div>
          </div>

          <details className="text-sm">
            <summary className="text-muted cursor-pointer hover:text-secondary">Usage example</summary>
            <pre className="mt-2 bg-surface-secondary p-3 rounded border border-th-border overflow-x-auto text-xs text-secondary">
              {`curl -X POST "${webhookResult.webhookUrl}" \\
  -H "Authorization: Bearer ${webhookResult.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"context": {"event": "example"}}'`}
            </pre>
          </details>

          <div className="flex justify-end pt-2">
            <button
              onClick={onClose}
              className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded hover:bg-accent-hover transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Schedule">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary placeholder:text-muted"
            placeholder="Daily standup reminder"
            required
          />
        </div>

        {/* Scope */}
        {!defaultScope && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Scope Type</label>
              <select
                value={scopeType}
                onChange={(e) => {
                  setScopeType(e.target.value as ScheduleScopeType)
                  setScopeId('')
                }}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
              >
                <option value="squad">Squad</option>
                <option value="agent">Agent</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1">
                {scopeType === 'squad' ? 'Squad' : 'Agent ID'}
              </label>
              {scopeType === 'squad' && squads ? (
                <select
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
                  required
                >
                  <option value="">Select a squad...</option>
                  {squads.map((squad) => (
                    <option key={squad.id} value={squad.id}>
                      {squad.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary placeholder:text-muted"
                  placeholder="Agent ID"
                  required
                />
              )}
            </div>
          </div>
        )}

        {/* Schedule Type */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1">Trigger Type</label>
          <select
            value={scheduleType}
            onChange={(e) => setScheduleType(e.target.value as ScheduleType)}
            className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
          >
            <option value="interval">Interval</option>
            <option value="cron">Cron</option>
            <option value="runAt">One-time</option>
            <option value="webhookOnly">Webhook Only</option>
          </select>
          {scheduleType === 'webhookOnly' && (
            <p className="text-xs text-muted mt-1">
              Triggered only via HTTP webhook. No automatic time-based triggers.
            </p>
          )}
        </div>

        {scheduleType === 'interval' && (
          <div>
            <label className="block text-sm font-medium text-primary mb-1">Interval</label>
            <input
              type="text"
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary placeholder:text-muted"
              placeholder="1h, 30m, 1d"
              required
            />
            <p className="text-xs text-muted mt-1">Examples: 15m, 1h, 24h</p>
          </div>
        )}

        {scheduleType === 'cron' && (
          <div>
            <label className="block text-sm font-medium text-primary mb-1">Cron Expression</label>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary placeholder:text-muted"
              placeholder="0 9 * * *"
              required
            />
            <p className="text-xs text-muted mt-1">Standard 5-field cron format</p>
          </div>
        )}

        {scheduleType === 'runAt' && (
          <div>
            <label className="block text-sm font-medium text-primary mb-1">Run At</label>
            <input
              type="datetime-local"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
              className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
              required
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-primary mb-1">Expires (optional)</label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
          />
        </div>

        {/* Action Type */}
        <div>
          <label className="block text-sm font-medium text-primary mb-1">Action</label>
          <select
            value={actionType}
            onChange={(e) => setActionType(e.target.value as ScheduleActionType)}
            className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface-secondary text-primary"
          >
            <option value="inbox_message">Send Inbox Message</option>
            {isSquadScope && <option value="spawn_agent">Spawn Agent</option>}
            {isSquadScope && <option value="create_work_stream">Create Work Stream</option>}
          </select>
        </div>

        {/* Action-specific fields */}
        {actionType === 'inbox_message' && (
          <div className="space-y-3 p-3 border border-th-border rounded bg-surface-secondary/50">
            {isSquadScope && (
              <label className="flex items-center gap-2 text-primary">
                <input
                  type="checkbox"
                  checked={targetManager}
                  onChange={(e) => setTargetManager(e.target.checked)}
                  className="rounded border-th-border"
                />
                <span className="text-sm">Send to squad manager</span>
              </label>
            )}
            {!targetManager && (
              <div>
                <label className="block text-sm font-medium text-primary mb-1">Target Agent ID</label>
                <input
                  type="text"
                  value={targetAgentId}
                  onChange={(e) => setTargetAgentId(e.target.value)}
                  className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted"
                  required={!targetManager}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Subject (optional)</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Content</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted min-h-[80px]"
                required
              />
            </div>
          </div>
        )}

        {actionType === 'spawn_agent' && (
          <div className="space-y-3 p-3 border border-th-border rounded bg-surface-secondary/50">
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Agent Type</label>
              <select
                value={agentTypeId}
                onChange={(e) => setAgentTypeId(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary"
                required
              >
                <option value="">Select agent type...</option>
                {agentTypes?.filter(isWorkerAgentType).map((at) => (
                  <option key={at.id} value={at.id}>
                    {at.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted min-h-[80px]"
                required
              />
            </div>
          </div>
        )}

        {actionType === 'create_work_stream' && (
          <div className="space-y-3 p-3 border border-th-border rounded bg-surface-secondary/50">
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Title</label>
              <input
                type="text"
                value={wsTitle}
                onChange={(e) => setWsTitle(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-primary mb-1">Description (optional)</label>
              <textarea
                value={wsDescription}
                onChange={(e) => setWsDescription(e.target.value)}
                className="ficus-field w-full px-3 py-2 border border-th-border rounded bg-surface text-primary placeholder:text-muted min-h-[60px]"
              />
            </div>
            <WorkflowPicker
              squadId={scopeId}
              value={workflow}
              onChange={setWorkflow}
              onUseSquadDefault={() => setWorkflow(undefined)}
              onCustomize={(initial) => setFlowEditor({ session: Date.now(), initial })}
              preview={false}
            />
            {flowEditor && (
              <WorkflowEditorModal
                key={flowEditor.session}
                isOpen
                squadId={scopeType === 'squad' ? scopeId : undefined}
                initialDefinition={flowEditor.initial}
                onClose={() => setFlowEditor(null)}
                onSave={(definition) => {
                  setWorkflow({ kind: 'inline', definition })
                  setFlowEditor(null)
                }}
              />
            )}
            <p className="text-xs text-muted">
              The squad default is resolved when the schedule runs. Workers start only as their flow steps become
              active.
            </p>
          </div>
        )}

        {actionType === 'create_work_stream' && (
          <label className="flex items-start gap-2 text-primary">
            <input
              type="checkbox"
              checked={skipIfUnresolved}
              onChange={(e) => setSkipIfUnresolved(e.target.checked)}
              className="mt-0.5 rounded border-th-border"
            />
            <span>
              <span className="block text-sm">Skip if prior work stream still open</span>
              <span className="block text-xs text-muted">Useful for recurring jobs that may get stuck.</span>
            </span>
          </label>
        )}

        {/* Error */}
        {createMutation.error && (
          <div className="text-status-danger-500 dark:text-status-danger-400 text-sm">
            {(createMutation.error as Error).message}
          </div>
        )}

        {/* Submit */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="ficus-button px-4 py-2 text-secondary hover:text-primary rounded hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {createMutation.isPending ? 'Creating...' : 'Create Schedule'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
