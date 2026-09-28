import { WorkflowParticipantTierField } from './WorkflowParticipantEditor'
import type { PageEditorAssistant } from '../PageEditorAssistant'
import { isWorkflowTextTarget, workflowHistoryKey } from '../../lib/workflowEditing'
import { isWorkerAgentType } from '@ficus/shared'
import { WorkflowBuilder } from './WorkflowBuilder'
import { useStableRef } from '../../hooks/useStableRef'
import { WorkflowGraph } from '../WorkflowGraph'
import { WorkflowStructureEditor } from './WorkflowStructureEditor'
import { useState, useEffect, useRef, useId } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  createBlankWorkflow,
  normalizeWorkflowJoins,
  resolveWorkflow,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type AssistantEditorPreset,
  type WorkflowSource,
} from '@ficus/shared'
import { queries } from '../../queryOptions'
import { client } from '../../api/clientInstance'

const historyKey = (source: WorkflowSource | undefined) =>
  source?.kind === 'inline' ? workflowHistoryKey(source.definition) : JSON.stringify(source)

const field = 'ficus-field w-full px-3 py-2 border border-th-border rounded-md bg-surface text-primary'

/** The graph remains declarative; this editor exposes its ordered steps without hiding advanced routing. */
export function WorkflowEditor({
  squadId,
  value,
  onChange: changeSource,
  disabled = false,
  shared = false,
  definitionOnly = false,
  nameInHeader = false,
  presetId,
  preset,
  onPresetChange,
  assistantDependencies,
  graphPositions,
  onGraphPositionsChange,
}: {
  squadId?: string
  graphPositions?: Record<string, { x: number; y: number }>
  onGraphPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void
  value?: WorkflowSource
  onChange: (source: WorkflowSource | undefined) => void
  disabled?: boolean
  shared?: boolean
  definitionOnly?: boolean
  nameInHeader?: boolean
  presetId?: string
  preset?: AssistantEditorPreset
  onPresetChange?: (preset: AssistantEditorPreset) => void
  assistantDependencies?: Parameters<typeof PageEditorAssistant>[0]['conversationDependencies']
}) {
  const nameHelpId = useId()
  const [revision, setRevision] = useState(0)
  type Snapshot = { source: WorkflowSource | undefined; preset?: AssistantEditorPreset }
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const snapshot: Snapshot = { source: value, preset }
  const previous = useRef(snapshot)
  const localValue = useStableRef(snapshot)
  const onChange = (next: WorkflowSource | undefined, nextPreset = preset) => {
    if (next?.kind === 'inline') next = { ...next, definition: normalizeWorkflowJoins(next.definition) }
    const nextSnapshot = { source: next, preset: nextPreset }
    if (JSON.stringify(nextSnapshot) === JSON.stringify(localValue.current)) return
    const before = structuredClone(localValue.current)
    if (historyKey(before.source) !== historyKey(next)) {
      if (before.source) setPast((items) => [...items.slice(-49), before])
      setFuture([])
    }
    previous.current = nextSnapshot
    localValue.current = nextSnapshot
    setRevision((revision) => revision + 1)
    changeSource(next)
    if (nextPreset) onPresetChange?.(nextPreset)
  }
  useEffect(() => {
    const next = { source: value, preset }
    if (JSON.stringify(previous.current) !== JSON.stringify(next)) {
      const previousValue = previous.current
      if (historyKey(previousValue.source) !== historyKey(value)) {
        if (previousValue.source) setPast((items) => [...items.slice(-49), structuredClone(previousValue)])
        setFuture([])
      }
      previous.current = next
      setRevision((revision) => revision + 1)
    }
  }, [value, preset])
  const restore = (redo: boolean) => {
    const stack = redo ? future : past
    const saved = stack.at(-1)
    if (disabled || !saved?.source || !value) return
    const next: Snapshot = { source: structuredClone(saved.source), preset }
    if (next.source?.kind === 'inline' && value.kind === 'inline') next.source.definition.name = value.definition.name
    if (!next.source) return
    const restoredDefinition =
      next.source.kind === 'inline'
        ? next.source.definition
        : resolveWorkflow(
            next.source,
            catalog.find((entry) => entry.id === (next.source as { id: string }).id)
          ).definition
    if (redo) {
      setFuture(stack.slice(0, -1))
      setPast([...past, snapshot])
    } else {
      setPast(stack.slice(0, -1))
      setFuture([...future, snapshot])
    }
    previous.current = next
    localValue.current = next
    setRevision((revision) => revision + 1)
    changeSource(next.source)
    return {
      definition: restoredDefinition,
      preset: next.preset,
      history: { canUndo: redo || past.length > 1, canRedo: !redo || future.length > 1 },
    }
  }
  const { data: catalog = [] } = useQuery(queries.workflows.list())
  const { data: agentTypes = [] } = useQuery(queries.agentTypes.list())
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  let definition = value?.kind === 'inline' ? value.definition : undefined
  let resolutionError: string | undefined
  if (value?.kind === 'preset') {
    const preset = catalog.find((entry) => entry.id === value.id)
    if (preset) {
      try {
        definition = resolveWorkflow(value, preset).definition
      } catch (error) {
        resolutionError = (error as Error).message
      }
    }
  }
  const parse = useMutation({
    mutationFn: async () => {
      if (squadId) return client.workflows.parse(squadId, raw)
      return workflowDefinitionSchema.parse(JSON.parse(raw))
    },
    onSuccess: (definition) => {
      onChange({ kind: 'inline', definition })
      setError(null)
    },
    onError: (error) => setError(error.message),
  })
  function edit(update: (draft: WorkflowDefinition) => void) {
    if (!definition) return
    const draft = structuredClone(definition)
    update(draft)
    onChange({ kind: 'inline', definition: draft })
  }
  const validation = definition ? workflowDefinitionSchema.safeParse(definition) : null
  const rawEditor = (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && definition) setRaw(JSON.stringify(definition, null, 2))
      }}
    >
      <summary className="cursor-pointer text-sm text-secondary">
        Edit complete definition{squadId ? ' (YAML or JSON)' : ' (JSON)'}
      </summary>
      <p className="text-xs text-secondary my-2">
        Add participants, reorder steps, define return paths, human approvals, and delivery policy here.
      </p>
      <textarea
        aria-label="Workflow definition"
        className={`${field} font-mono text-xs min-h-56`}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <button
        type="button"
        disabled={parse.isPending}
        className="px-3 py-2 text-sm border border-th-border rounded-md mt-2"
        onClick={() => parse.mutate()}
      >
        Apply definition
      </button>
      {error && (
        <p role="alert" className="text-sm text-status-danger-400">
          {error}
        </p>
      )}
    </details>
  )
  return (
    <fieldset
      disabled={disabled}
      className={
        definitionOnly
          ? 'flex min-w-0 w-full shrink-0 flex-col lg:min-h-0 lg:flex-1'
          : 'min-w-0 w-full max-w-full space-y-3'
      }
      onKeyDown={(event) => {
        if (
          disabled ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          isWorkflowTextTarget(event.target) ||
          event.altKey ||
          !(event.metaKey || event.ctrlKey)
        )
          return
        const key = event.key.toLowerCase()
        if (key === 'z' || (key === 'y' && event.ctrlKey && !event.shiftKey)) {
          event.preventDefault()
          event.stopPropagation()
          restore(key === 'y' || event.shiftKey)
        }
      }}
    >
      {!definitionOnly && (
        <label className="block text-sm font-medium">
          Workflow
          <select
            className={`${field} mt-1`}
            value={value?.kind === 'inline' ? 'custom' : value?.kind === 'preset' ? value.id : ''}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                if (definition) onChange({ kind: 'inline', definition: structuredClone(definition) })
                return
              }
              onChange(e.target.value ? { kind: 'preset', id: e.target.value, customizations: [] } : undefined)
            }}
          >
            <option value="">Use squad default</option>
            {catalog
              .filter(
                (entry) =>
                  !entry.disabled &&
                  (!entry.scope ||
                    entry.scope.kind === 'instance' ||
                    (!shared && entry.scope.kind === 'user') ||
                    (entry.scope.kind === 'squad' && entry.scope.squadId === squadId))
              )
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.definition.name}
                </option>
              ))}
            {value?.kind === 'inline' && <option value="custom">Custom flow</option>}
          </select>
        </label>
      )}
      {!definition && (
        <button
          type="button"
          className="text-sm text-accent"
          onClick={() => onChange({ kind: 'inline', definition: createBlankWorkflow() })}
        >
          Create a custom flow
        </button>
      )}
      {resolutionError && (
        <p role="alert" className="text-sm text-status-danger-400">
          {resolutionError}
        </p>
      )}
      {definition && (
        <>
          {definitionOnly ? (
            <>
              <WorkflowBuilder
                definition={definition}
                onChange={(definition, nextPreset) => onChange({ kind: 'inline', definition }, nextPreset)}
                preset={preset}
                revision={revision}
                history={{ canUndo: past.length > 0, canRedo: future.length > 0 }}
                onHistory={(action) => restore(action === 'redo')}
                presetId={presetId}
                graphPositions={graphPositions}
                onGraphPositionsChange={onGraphPositionsChange}
                assistantDependencies={assistantDependencies}
                disabled={disabled}
                advancedContent={
                  <>
                    {!nameInHeader && (
                      <label className="block text-sm">
                        Name
                        <span id={nameHelpId} className="block text-xs text-muted">
                          The display name people see when choosing a workflow.
                        </span>
                        <input
                          className={field}
                          aria-label="Name"
                          aria-describedby={nameHelpId}
                          value={definition.name}
                          onChange={(event) =>
                            edit((draft) => {
                              draft.name = event.target.value
                            })
                          }
                        />
                      </label>
                    )}
                    {rawEditor}
                  </>
                }
              />
            </>
          ) : (
            <WorkflowGraph definition={definition} />
          )}
          {!definitionOnly && (
            <details>
              <summary className="cursor-pointer text-sm text-secondary">Customize steps and participants</summary>
              <div className="space-y-3 pt-3">
                {!definitionOnly && (
                  <label className="block text-sm">
                    Name
                    <input
                      className={field}
                      value={definition.name}
                      onChange={(e) =>
                        edit((draft) => {
                          draft.name = e.target.value
                        })
                      }
                    />
                  </label>
                )}
                {Object.entries(definition.participants).map(([id, participant]) => (
                  <div key={id} className="grid gap-2 sm:grid-cols-3 border-t border-th-border pt-3">
                    <label className="text-xs text-secondary">
                      {id} · Agent type
                      <select
                        className={field}
                        value={participant.agentTypeId}
                        onChange={(e) =>
                          edit((draft) => {
                            draft.participants[id]!.agentTypeId = e.target.value
                          })
                        }
                      >
                        {!agentTypes.some(
                          (agentType) => agentType.id === participant.agentTypeId && isWorkerAgentType(agentType)
                        ) && (
                          <option value={participant.agentTypeId} disabled>
                            {participant.agentTypeId} (unavailable for workers)
                          </option>
                        )}
                        {agentTypes.filter(isWorkerAgentType).map((agentType) => (
                          <option key={agentType.id} value={agentType.id}>
                            {agentType.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <WorkflowParticipantTierField
                      participant={participant}
                      onChange={(next) =>
                        edit((draft) => {
                          draft.participants[id] = next
                        })
                      }
                    />
                    <label className="text-xs text-secondary">
                      Session
                      <select
                        className={field}
                        value={participant.session}
                        onChange={(e) =>
                          edit((draft) => {
                            draft.participants[id]!.session = e.target.value as typeof participant.session
                          })
                        }
                      >
                        <option value="reuse-within-stream">Reuse on return</option>
                        <option value="fresh-per-attempt">Fresh each attempt</option>
                      </select>
                    </label>
                  </div>
                ))}
                <ol className="space-y-3">
                  {definition.steps.map((step, index) => (
                    <li key={step.id} className="border-t border-th-border pt-3 space-y-2">
                      <div className="text-sm font-medium">
                        {index + 1}. {step.id} · {step.kind === 'agent' ? step.participant : 'Human approval'}
                      </div>
                      <label className="block text-xs text-secondary">
                        Instructions
                        <textarea
                          className={field}
                          value={step.instructions}
                          onChange={(e) =>
                            edit((draft) => {
                              draft.steps[index]!.instructions = e.target.value
                            })
                          }
                        />
                      </label>
                      <label className="block text-xs text-secondary">
                        Expected result
                        <input
                          className={field}
                          value={step.output}
                          onChange={(e) =>
                            edit((draft) => {
                              draft.steps[index]!.output = e.target.value
                            })
                          }
                        />
                      </label>
                      <div className="text-xs text-secondary">
                        {Object.entries(step.outcomes)
                          .map(
                            ([outcome, target]) =>
                              `${outcome} → ${'next' in target ? target.next : 'parallel' in target ? `${target.parallel.join(' + ')}, join at ${target.join}` : `${target.returnTo}, then ${target.afterRework === 'return-to-requester' ? 'return to requester' : 'follow graph'}`}`
                          )
                          .join(' · ')}
                      </div>
                    </li>
                  ))}
                </ol>
                <WorkflowStructureEditor
                  definition={definition}
                  onChange={(definition) => onChange({ kind: 'inline', definition })}
                />
              </div>
            </details>
          )}
        </>
      )}
      {!definitionOnly && rawEditor}
      {!definitionOnly && validation && !validation.success && (
        <p role="alert" className="text-sm text-status-danger-400">
          {validation.error.issues[0]?.message}
        </p>
      )}
    </fieldset>
  )
}
