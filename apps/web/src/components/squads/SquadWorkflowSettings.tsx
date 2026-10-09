import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type WorkflowSource } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { updateSquad } from '../../api/squads'
import { client } from '../../api/clientInstance'
import { WorkflowPicker } from './WorkflowPicker'
import { Link } from 'react-router-dom'
import { usePermissions } from '../../hooks/usePermissions'

export function SquadWorkflowSettings({ squadId, canEdit }: { squadId: string; canEdit: boolean }) {
  const { can } = usePermissions()
  const { data: catalog = [] } = useQuery(queries.workflows.list())
  const { data: squad } = useQuery(queries.squads.detail(squadId))
  const [editing, setEditing] = useState(false)
  const [source, setSource] = useState<WorkflowSource>()
  const [guidance, setGuidance] = useState('')
  const [choices, setChoices] = useState<Array<{ when: string; source?: WorkflowSource }>>([])
  const queryClient = useQueryClient()
  const saved = (squad?.metadata?.workflow as WorkflowSource | undefined) ?? squad?.defaultWorkflow
  const setup = squad?.metadata?.workflowSetup as
    | { guidance: string; choices: Array<{ when: string; source: WorkflowSource }>; completedAt?: string }
    | undefined
  const save = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error('Choose a default workflow.')
      await client.workflows.resolve(squadId, source)
      return updateSquad(squadId, {
        metadata: {
          workflow: source,
          workflowSetup: {
            guidance,
            choices: choices.filter((choice) => choice.source),
            completedAt: new Date().toISOString(),
          },
        },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) })
      setEditing(false)
    },
  })
  return (
    <section className="min-w-0 w-full max-w-full my-6 space-y-4 border-y border-th-border py-6">
      <div className="flex justify-between items-center gap-3">
        <h3 className="text-sm font-medium text-primary" data-setting-target="default-workflow">
          Default workflow
        </h3>
        {canEdit && !editing && (
          <button
            type="button"
            className="ficus-button ficus-button-link text-sm font-medium"
            onClick={() => {
              setSource(saved ?? { kind: 'preset', id: 'solo', customizations: [] })
              setGuidance(setup?.guidance ?? '')
              setChoices(structuredClone(setup?.choices ?? []))
              setEditing(true)
            }}
          >
            Edit
          </button>
        )}
      </div>
      <p className="text-xs text-secondary">
        Applies to new work streams. Existing work keeps its current flow. Persistent squad members are configured
        separately.
      </p>
      {can('workflows:read') && (
        <Link to="/settings?section=workflows" className="inline-block text-sm text-accent-light hover:underline">
          Manage workflows →
        </Link>
      )}
      {editing ? (
        <>
          <WorkflowPicker squadId={squadId} value={source} onChange={setSource} disabled={save.isPending} />
          <label className="block text-sm">
            When to use different workflows
            <textarea
              className="ficus-field mt-2 w-full rounded-md border border-th-border bg-surface px-3 py-2 text-sm"
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              maxLength={16000}
              rows={3}
              placeholder="Use Solo for small tasks. Ask for an independent review for sensitive changes."
            />
          </label>
          <p className="text-xs text-secondary">
            The manager uses this guidance when choosing a flow. Directly created work uses the default above.
          </p>
          <div className="space-y-4">
            {choices.map((choice, index) => (
              <div key={index} className="border-t border-th-border pt-3 space-y-2">
                <label className="block text-sm">
                  When to use alternative {index + 1}
                  <input
                    className="ficus-field w-full p-2 border border-th-border rounded-md"
                    value={choice.when}
                    onChange={(event) =>
                      setChoices(
                        choices.map((entry, i) => (i === index ? { ...entry, when: event.target.value } : entry))
                      )
                    }
                  />
                </label>
                <WorkflowPicker
                  squadId={squadId}
                  value={choice.source}
                  onChange={(source) => {
                    setChoices(choices.map((entry, i) => (i === index ? { ...entry, source } : entry)))
                  }}
                  disabled={save.isPending}
                />
                <button
                  type="button"
                  className="text-xs text-secondary"
                  onClick={() => setChoices(choices.filter((_, i) => i !== index))}
                >
                  Remove alternative {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="ficus-button ficus-button-link text-sm font-medium"
              disabled={choices.length >= 32 || save.isPending}
              onClick={() => setChoices([...choices, { when: '' }])}
            >
              Add alternative workflow
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-th-border pt-4">
            <button
              type="button"
              className="ficus-button ficus-button-primary rounded-md px-3 py-2 text-sm disabled:opacity-50"
              disabled={save.isPending || !source || choices.some((choice) => !choice.when.trim() || !choice.source)}
              onClick={() => save.mutate()}
            >
              Save workflows
            </button>
            <button type="button" className="text-sm text-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {save.error && (
            <p role="alert" className="text-sm text-status-danger-400">
              {save.error.message}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-sm">
            {saved?.kind === 'preset'
              ? (catalog.find((entry) => entry.id === saved.id)?.definition.name ?? saved.id)
              : saved?.kind === 'inline'
                ? saved.definition.name
                : 'Choose a default workflow'}
          </p>
          {!saved && (
            <p className="text-xs text-secondary">
              This squad predates default workflows. Choose Edit to save Solo or another preset for new work streams.
            </p>
          )}
          {setup?.guidance && <p className="text-sm text-secondary whitespace-pre-wrap">{setup.guidance}</p>}
          {setup?.choices.map((choice, index) => (
            <p key={index} className="text-xs text-secondary">
              {choice.when}: {choice.source.kind === 'preset' ? choice.source.id : choice.source.definition.name}
            </p>
          ))}
        </>
      )}
    </section>
  )
}
