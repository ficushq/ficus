import { FLOW_START_ID } from '../../lib/workflowGraph'
import { WorkflowParticipantEditor } from './WorkflowParticipantEditor'
import { WorkflowEventEditor } from './WorkflowEventEditor'
import { useMemo, useState, useRef, type ReactNode } from 'react'
import { useStableRef } from '../../hooks/useStableRef'
import clsx from 'clsx'
import {
  workflowDefinitionSchema,
  assistantEditorInstructionsByKind,
  assistantEditorToolDefinitionsByKind,
  type AssistantEditorPreset,
  type AssistantEditorProposal,
  type WorkflowDefinition,
} from '@ficus/shared'
import { usePermissions } from '../../hooks/usePermissions'
import { PageEditorAssistant } from '../PageEditorAssistant'
import { WorkflowGraph } from '../WorkflowGraph'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'
import {
  CloseIcon,
  AgentIcon,
  HumanApprovalIcon,
  InspectorIcon,
  ParticipantsIcon,
  SettingsIcon,
  UndoIcon,
  RedoIcon,
} from '../icons'
import { WorkflowStructureEditor, WorkflowCompletionEditor } from './WorkflowStructureEditor'
import {
  insertWorkflowStep,
  separateWorkflowParticipant,
  renameWorkflowStep,
  connectWorkflowOutcome,
  removeWorkflowStep,
  removeWorkflowConnection,
  workflowDraftWarning,
  workflowHistoryKey,
  isWorkflowTextTarget,
} from '../../lib/workflowEditing'

type StepKind = WorkflowDefinition['steps'][number]['kind']

const stepKindOptions: SegmentedControlOption<StepKind>[] = [
  { value: 'agent', label: 'Agent work' },
  { value: 'human-approval', label: 'Human approval' },
]

const field = 'ficus-field w-full min-w-0 rounded-md border border-th-border bg-surface px-3 py-2 text-sm'
const button =
  'ficus-button ficus-button-ghost flex h-8 w-8 shrink-0 items-center justify-center rounded-md disabled:opacity-40'

export function WorkflowBuilder({
  definition,
  onChange,
  revision,
  presetId,
  preset,
  disabled,
  advancedContent,
  onHistory,
  history,
  assistantDependencies,
  graphPositions,
  onGraphPositionsChange,
}: {
  definition: WorkflowDefinition
  graphPositions?: Record<string, { x: number; y: number }>
  onGraphPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void
  onChange: (definition: WorkflowDefinition, preset?: AssistantEditorPreset) => void
  revision: number
  presetId?: string
  preset?: AssistantEditorPreset
  assistantDependencies?: Parameters<typeof PageEditorAssistant>[0]['conversationDependencies']
  disabled?: boolean
  advancedContent?: ReactNode
  history?: { canUndo: boolean; canRedo: boolean }
  onHistory?: (action: 'undo' | 'redo') =>
    | {
        definition: WorkflowDefinition
        preset?: AssistantEditorPreset
        history: { canUndo: boolean; canRedo: boolean }
      }
    | undefined
}) {
  const canvas = useRef<HTMLDivElement>(null)
  const [localGraphPositions, setLocalGraphPositions] = useState<Record<string, { x: number; y: number }>>({})
  const positions = graphPositions ?? localGraphPositions
  const saveGraphPositions = (next: typeof positions) => {
    setLocalGraphPositions(next)
    onGraphPositionsChange?.(next)
  }
  const [renameError, setRenameError] = useState<string>()
  const [selected, setSelected] = useState<string>(definition.entry)
  const [inspecting, setInspecting] = useState(false)
  const [tab, setTab] = useState<'step' | 'connection' | 'settings' | 'completion' | 'participants'>('step')
  const [connectionOutcome, setConnectionOutcome] = useState<string>()
  const [connectionError, setConnectionError] = useState<{ message: string; revision: number }>()
  const [dismissedNotice, setDismissedNotice] = useState<string>()
  const [selectedEdge, setSelectedEdge] = useState<{
    from: string
    label: string
    step: string
    outcome: string
    branch?: number
    branchTo?: string
    group?: boolean
  }>()
  const [lastEdit, setLastEdit] = useState<{
    summary: string
    before: WorkflowDefinition
    after: WorkflowDefinition
  }>()
  const [inspectedChanges, setInspectedChanges] = useState<string[]>([])
  const [assistantError, setAssistantError] = useState<string>()
  const [assistantArrangeRequest, setAssistantArrangeRequest] = useState(0)
  const { can } = usePermissions()
  const [selectedParticipant, setSelectedParticipant] = useState('')
  const previousParticipants = useRef<Record<string, string>>({})
  const selectedStep = definition.steps.find((step) => step.id === selected)
  const selectedIndex = definition.steps.findIndex((step) => step.id === selected)
  const notice =
    (connectionError?.revision === revision ? { message: connectionError.message } : undefined) ??
    workflowDraftWarning(definition)
  const noticeKey = `${revision}:${JSON.stringify(notice)}`
  const edgeTarget =
    selectedEdge && definition.steps.find((step) => step.id === selectedEdge.step)?.outcomes[selectedEdge.outcome]
  const branchIndex =
    selectedEdge?.branchTo && edgeTarget && 'parallel' in edgeTarget
      ? edgeTarget.parallel.indexOf(selectedEdge.branchTo)
      : -1
  const activeEdge =
    selectedEdge && edgeTarget
      ? selectedEdge.branchTo
        ? branchIndex >= 0
          ? { ...selectedEdge, branch: branchIndex, label: `${selectedEdge.outcome} · branch ${branchIndex + 1}` }
          : undefined
        : selectedEdge
      : undefined
  const draft = useMemo(
    () => ({
      kind: 'workflow' as const,
      target: presetId ? { presetId } : {},
      revision,
      document: definition,
      selection: selected,
      history,
      preset,
    }),
    [presetId, revision, definition, selected, history, preset]
  )
  const current = useStableRef({ definition, revision, disabled, onChange, onHistory, draft })
  const applyAssistantEdit = (proposal: AssistantEditorProposal) => {
    const latest = current.current
    if (proposal.historyAction) {
      if (latest.disabled || proposal.baseRevision !== latest.revision) {
        setAssistantError('The draft changed. Ask the assistant to read it before undoing or redoing.')
        return undefined
      }
      const restored = latest.onHistory?.(proposal.historyAction)
      if (!restored) {
        setAssistantError(`Nothing to ${proposal.historyAction}.`)
        return undefined
      }
      const nextDraft = {
        ...latest.draft,
        document: restored.definition,
        preset: restored.preset,
        revision: latest.revision + 1,
        history: restored.history,
      }
      current.current = { ...latest, definition: restored.definition, revision: nextDraft.revision, draft: nextDraft }
      setAssistantError(undefined)
      setLastEdit(undefined)
      if (workflowHistoryKey(restored.definition) !== workflowHistoryKey(latest.definition))
        setAssistantArrangeRequest((request) => request + 1)
      return nextDraft
    }
    const parsed = workflowDefinitionSchema.safeParse(proposal.document)
    if (latest.disabled || proposal.baseRevision !== latest.revision || !parsed.success) {
      setAssistantError(
        !parsed.success
          ? 'The assistant’s edit was invalid. Ask it to repair the flow.'
          : 'The draft changed before this edit arrived. Ask the assistant to retry using the latest version.'
      )
      return undefined
    }
    setAssistantError(undefined)
    const unchanged =
      JSON.stringify(parsed.data) === JSON.stringify(latest.definition) &&
      JSON.stringify(proposal.preset ?? latest.draft.preset) === JSON.stringify(latest.draft.preset)
    const nextDraft = {
      ...latest.draft,
      document: parsed.data,
      preset: proposal.preset ?? latest.draft.preset,
      revision: latest.revision + (unchanged ? 0 : 1),
      history:
        workflowHistoryKey(parsed.data) === workflowHistoryKey(latest.definition)
          ? latest.draft.history
          : { canUndo: true, canRedo: false },
    }
    if (!unchanged) {
      if (workflowHistoryKey(parsed.data) !== workflowHistoryKey(latest.definition))
        setAssistantArrangeRequest((request) => request + 1)
      setInspectedChanges([])
      setLastEdit({ summary: proposal.summary, before: structuredClone(latest.definition), after: parsed.data })
      // Update immediately so consecutive responses cannot reuse the old revision before React renders.
      current.current = { ...latest, definition: parsed.data, revision: nextDraft.revision, draft: nextDraft }
      latest.onChange(parsed.data, nextDraft.preset)
    }
    return nextDraft
  }
  const edit = (update: (draft: WorkflowDefinition) => void) => {
    const copy = structuredClone(definition)
    update(copy)
    onChange(copy)
  }
  const select = (id: string) => {
    setInspectedChanges((ids) => [...ids, id])
    setSelectedEdge(undefined)
    setConnectionOutcome(undefined)
    setInspecting(true)
    setSelected(id)
    setTab(
      id === 'finish'
        ? 'completion'
        : id === FLOW_START_ID || definition.steps.some((step) => step.id === id)
          ? 'step'
          : 'settings'
    )
  }
  const add = (human: boolean) => {
    setSelectedEdge(undefined)
    const result = insertWorkflowStep(definition, selected, human)
    onChange(result.definition)
    setSelected(result.selected)
    setInspecting(true)
    setTab('step')
  }
  const removeSelected = () => {
    if (disabled) return
    if (activeEdge) {
      onChange(removeWorkflowConnection(definition, activeEdge.step, activeEdge.outcome, activeEdge.branch))
      setSelectedEdge(undefined)
      setSelected('')
      setConnectionOutcome(undefined)
      setInspecting(false)
      canvas.current?.focus()
      return
    }
    if (selectedEdge || !selectedStep) return
    const next = removeWorkflowStep(definition, selectedStep.id)
    onChange(next)
    setSelected(next.steps[Math.min(selectedIndex, next.steps.length - 1)]?.id ?? '')
    setConnectionOutcome(undefined)
    setTab('step')
    canvas.current?.focus()
  }
  const changeStepKind = (kind: StepKind) => {
    if (!selectedStep || selectedStep.kind === kind) return
    if (selectedStep.kind === 'agent') previousParticipants.current[selectedStep.id] = selectedStep.participant
    edit((draft) => {
      const { id, name, instructions, output, outcomes } = selectedStep
      if (kind === 'human-approval')
        draft.steps[selectedIndex] = {
          id,
          name,
          instructions,
          output,
          outcomes,
          kind,
          approver: 'assigned-reviewers',
        }
      else {
        const previous = previousParticipants.current[id]
        const participant =
          previous && draft.participants[previous] ? previous : (Object.keys(draft.participants)[0] ?? 'worker')
        draft.participants[participant] ??= {
          agentTypeId: 'general',
          session: 'reuse-within-stream',
        }
        draft.steps[selectedIndex] = {
          id,
          name,
          instructions,
          output,
          outcomes,
          kind,
          participant,
        }
      }
    })
  }
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div
        className={clsx(
          'grid min-w-0 auto-rows-max gap-4 lg:min-h-0 lg:flex-1 lg:auto-rows-auto',
          can('chat:send') && 'lg:grid-cols-[minmax(18rem,0.7fr)_minmax(0,2fr)]'
        )}
      >
        {can('chat:send') && (
          <div className="min-w-0 min-h-[28rem] lg:min-h-0 flex flex-col" data-flow-shortcuts="off">
            <PageEditorAssistant
              draft={draft}
              onProposal={applyAssistantEdit}
              conversationDependencies={assistantDependencies}
              title={presetId ? 'What would you like to change?' : 'What flow do you want?'}
              subtitle="Build and refine your flow together. Graph edits appear immediately and can be undone."
              conversationTitle="Design a workflow"
              instructions={assistantEditorInstructionsByKind.workflow}
              tools={assistantEditorToolDefinitionsByKind.workflow}
            />
          </div>
        )}
        <section
          aria-label="Live flow preview"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
            if (!selected && !selectedEdge && !inspecting) return
            event.preventDefault()
            event.stopPropagation()
            setSelected('')
            setSelectedEdge(undefined)
            setConnectionOutcome(undefined)
            setInspecting(false)
            canvas.current?.focus()
          }}
          className="flex min-w-0 min-h-0 h-[min(36rem,calc(100dvh-8rem))] shrink-0 lg:h-auto flex-col gap-2 overflow-hidden rounded-xl border border-th-border bg-surface p-3"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-1" role="group" aria-label="Workflow panels">
            {(['inspector', 'participants', 'settings'] as const).map((panel) => (
              <button
                key={panel}
                type="button"
                aria-label={
                  panel === 'inspector' ? 'Inspector' : panel === 'participants' ? 'Participants' : 'Flow settings'
                }
                aria-pressed={
                  inspecting && (panel === 'inspector' ? tab !== 'settings' && tab !== 'participants' : tab === panel)
                }
                aria-expanded={
                  inspecting && (panel === 'inspector' ? tab !== 'settings' && tab !== 'participants' : tab === panel)
                }
                className={clsx(
                  'ficus-button ficus-button-ghost flex items-center gap-2 rounded-md px-2 sm:px-3 py-1.5 text-sm',
                  inspecting &&
                    (panel === 'inspector' ? tab !== 'settings' && tab !== 'participants' : tab === panel) &&
                    'bg-surface-hover text-accent-light'
                )}
                onClick={() => {
                  setInspecting(
                    !(
                      inspecting &&
                      (panel === 'inspector' ? tab !== 'settings' && tab !== 'participants' : tab === panel)
                    )
                  )
                  setTab(
                    panel === 'inspector'
                      ? selectedEdge
                        ? 'connection'
                        : selected === 'finish'
                          ? 'completion'
                          : 'step'
                      : panel
                  )
                }}
              >
                {panel === 'participants' ? (
                  <ParticipantsIcon className="hidden h-4 w-4 sm:block" />
                ) : panel === 'settings' ? (
                  <SettingsIcon className="hidden h-4 w-4 sm:block" />
                ) : (
                  <InspectorIcon className="hidden h-4 w-4 sm:block" />
                )}
                {panel === 'inspector' ? 'Inspector' : panel === 'participants' ? 'Participants' : 'Settings'}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row gap-3">
            <div
              ref={canvas}
              tabIndex={0}
              aria-label="Edit flow graph"
              className="flex min-w-0 min-h-0 flex-1 flex-col rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              onKeyDown={(event) => {
                if (
                  disabled ||
                  event.defaultPrevented ||
                  event.nativeEvent.isComposing ||
                  isWorkflowTextTarget(event.target)
                )
                  return
                if (
                  (event.key === 'Delete' || event.key === 'Backspace') &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  (selectedEdge ? activeEdge : selectedStep)
                ) {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!event.repeat) removeSelected()
                }
              }}
            >
              <WorkflowGraph
                editorLayout
                arrangeRequest={assistantArrangeRequest}
                onDeleteStep={disabled ? undefined : removeSelected}
                arrangeOnMount
                toolbar={
                  <>
                    {onHistory && (
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          className={clsx(button, 'disabled:opacity-40')}
                          disabled={disabled || !history?.canUndo}
                          title="Undo (⌘Z / Ctrl+Z)"
                          onClick={() => onHistory('undo')}
                        >
                          <UndoIcon className="h-4 w-4" />
                          <span className="sr-only">Undo</span>
                        </button>
                        <button
                          type="button"
                          className={clsx(button, 'disabled:opacity-40')}
                          disabled={disabled || !history?.canRedo}
                          title="Redo (⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y)"
                          onClick={() => onHistory('redo')}
                        >
                          <RedoIcon className="h-4 w-4" />
                          <span className="sr-only">Redo</span>
                        </button>
                      </div>
                    )}
                    <div className="flex flex-col gap-1 border-t border-th-border pt-1">
                      <button
                        type="button"
                        className={button}
                        disabled={
                          disabled ||
                          definition.steps.length >= 128 ||
                          Object.keys(definition.participants).length >= 64
                        }
                        title="Add agent step"
                        onClick={() => add(false)}
                      >
                        <AgentIcon className="h-4 w-4" />
                        <span className="sr-only">Add agent step</span>
                      </button>
                      <button
                        type="button"
                        className={button}
                        disabled={disabled || definition.steps.length >= 128}
                        title="Add approval"
                        onClick={() => add(true)}
                      >
                        <HumanApprovalIcon className="h-4 w-4" />
                        <span className="sr-only">Add approval</span>
                      </button>
                    </div>
                  </>
                }
                positions={positions}
                onPositionsChange={saveGraphPositions}
                fill
                changedStepIds={
                  lastEdit && JSON.stringify(definition) === JSON.stringify(lastEdit.after)
                    ? definition.steps
                        .filter(
                          (step) =>
                            !inspectedChanges.includes(step.id) &&
                            JSON.stringify(step) !==
                              JSON.stringify(lastEdit.before.steps.find((previous) => previous.id === step.id))
                        )
                        .map((step) => step.id)
                    : []
                }
                definition={definition}
                selectedId={selectedEdge ? '' : selected}
                selectedEdge={selected === FLOW_START_ID ? { from: FLOW_START_ID, label: 'starts' } : activeEdge}
                notice={noticeKey === dismissedNotice ? undefined : notice}
                onDismissNotice={() => setDismissedNotice(noticeKey)}
                onConnect={
                  disabled
                    ? undefined
                    : (from, outcome, to, branch) => {
                        try {
                          onChange(connectWorkflowOutcome(definition, from, outcome, to, branch))
                          setConnectionError(undefined)
                        } catch (error) {
                          setDismissedNotice(undefined)
                          setConnectionError({ message: (error as Error).message, revision })
                        }
                      }
                }
                onSelect={disabled ? undefined : select}
                onSelectEdge={
                  disabled
                    ? undefined
                    : (from, label) => {
                        if (from === FLOW_START_ID) {
                          select(FLOW_START_ID)
                          return
                        }
                        const id = from
                        const step = definition.steps.find((step) => step.id === id)
                        const outcome = Object.keys(step?.outcomes ?? {}).find(
                          (name) => label === name || label.startsWith(name + ' ·')
                        )
                        const branch = label.match(/ · branch (\d+)$/)
                        const target = outcome && definition.steps.find((step) => step.id === id)?.outcomes[outcome]
                        setSelectedEdge(
                          outcome
                            ? {
                                from,
                                label,
                                step: id,
                                outcome,
                                branch: branch ? Number(branch[1]) - 1 : undefined,
                                branchTo:
                                  branch && target && 'parallel' in target
                                    ? target.parallel[Number(branch[1]) - 1]
                                    : undefined,
                                group: !branch && !!target && 'parallel' in target,
                              }
                            : undefined
                        )
                        setInspecting(true)
                        setSelected(id)
                        setConnectionOutcome(outcome)
                        setTab(outcome ? 'connection' : 'settings')
                        canvas.current?.focus()
                      }
                }
              />
            </div>
            {inspecting && (
              <aside
                aria-label="Flow inspector"
                className="min-w-0 min-h-0 max-h-[32rem] lg:max-h-none flex flex-col overflow-hidden rounded-lg border border-th-border bg-surface lg:w-[22rem] shrink-0"
              >
                <div className="flex shrink-0 items-center justify-between px-4 py-3">
                  <h4 className="text-sm font-medium">
                    {tab === 'participants'
                      ? 'Participants'
                      : tab === 'settings'
                        ? 'Workflow settings'
                        : selected === FLOW_START_ID
                          ? 'Workflow start'
                          : tab === 'completion'
                            ? 'Finish'
                            : tab === 'connection'
                              ? activeEdge?.group
                                ? 'Parallel group'
                                : 'Handoff details'
                              : 'Step details'}
                  </h4>
                  <button
                    type="button"
                    aria-label="Close inspector"
                    className="ficus-button ficus-button-ghost p-1.5"
                    onClick={() => setInspecting(false)}
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </div>
                {tab === 'step' && (
                  <div className="workflow-inspector-form min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                    {selectedStep ? (
                      <>
                        <SegmentedControl
                          ariaLabel="Step kind"
                          options={stepKindOptions}
                          value={selectedStep.kind}
                          onChange={changeStepKind}
                        />
                        <label className="block text-sm">
                          Step name
                          <input
                            className={field}
                            maxLength={200}
                            value={selectedStep.name ?? selectedStep.id}
                            onChange={(event) =>
                              edit((draft) => {
                                const step = draft.steps[selectedIndex]!
                                step.name = event.target.value
                              })
                            }
                          />
                        </label>
                        <label className="block text-sm">
                          Instructions
                          <span className="block text-xs text-muted mb-1">What to do and check.</span>
                          <textarea
                            className={field}
                            rows={4}
                            aria-label="Step instructions"
                            value={selectedStep.instructions}
                            onChange={(e) =>
                              edit((draft) => {
                                draft.steps[selectedIndex]!.instructions = e.target.value
                              })
                            }
                          />
                        </label>
                        <label className="block text-sm">
                          Expected result
                          <span className="block text-xs text-muted mb-1">
                            The result and evidence this step should produce.
                          </span>
                          <textarea
                            className={field}
                            rows={2}
                            value={selectedStep.output}
                            onChange={(e) =>
                              edit((draft) => {
                                draft.steps[selectedIndex]!.output = e.target.value
                              })
                            }
                          />
                        </label>
                        {selectedStep.kind === 'agent' && (
                          <div className="space-y-2">
                            <label className="block text-sm">
                              Participant
                              <select
                                className={field}
                                value={selectedStep.participant}
                                onChange={(event) =>
                                  edit((draft) => {
                                    const step = draft.steps[selectedIndex]!
                                    if (step.kind === 'agent') step.participant = event.target.value
                                  })
                                }
                              >
                                {Object.keys(definition.participants).map((id) => (
                                  <option key={id} value={id}>
                                    {id}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p className="text-xs text-muted">
                              Agent type, model, and session settings are shared. This step keeps its own instructions.
                            </p>
                            <button
                              type="button"
                              className="ficus-button ficus-button-link text-sm"
                              onClick={() => {
                                setSelectedParticipant(selectedStep.participant)
                                setTab('participants')
                              }}
                            >
                              Edit shared settings
                            </button>
                            {definition.steps.filter(
                              (step) => step.kind === 'agent' && step.participant === selectedStep.participant
                            ).length > 1 && (
                              <button
                                type="button"
                                className="ficus-button ficus-button-link ml-3 text-sm disabled:opacity-40"
                                disabled={Object.keys(definition.participants).length >= 64}
                                onClick={() =>
                                  onChange(separateWorkflowParticipant(definition, selectedStep.id).definition)
                                }
                              >
                                Make separate
                              </button>
                            )}
                          </div>
                        )}
                        <details className="text-sm">
                          <summary className="cursor-pointer text-muted">Advanced</summary>
                          <div className="mt-3 space-y-2">
                            <label className="block text-sm">
                              Step ID
                              <span className="block text-xs text-muted mb-1">
                                Stable ID used by connections. Changing the step name leaves this unchanged.
                              </span>
                              <input
                                key={selectedStep.id}
                                className={field}
                                defaultValue={selectedStep.id}
                                onBlur={(event) => {
                                  const next = event.target.value.trim()
                                  if (next === selectedStep.id) return
                                  try {
                                    const renamed = renameWorkflowStep(definition, selectedStep.id, next)
                                    const point = positions[selectedStep.id]
                                    if (point) saveGraphPositions({ ...positions, [next]: point })
                                    onChange(renamed)
                                    setSelected(next)
                                    setRenameError(undefined)
                                  } catch (error) {
                                    setRenameError((error as Error).message)
                                    event.target.value = selectedStep.id
                                  }
                                }}
                              />
                            </label>
                            {renameError && (
                              <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
                                {renameError}
                              </p>
                            )}
                          </div>
                        </details>
                        <WorkflowStructureEditor
                          key={selected}
                          mode="step"
                          hideParticipant
                          onSelectOutcome={(name) => {
                            setConnectionOutcome(name)
                            setSelectedEdge(
                              name ? { from: selected, label: name, step: selected, outcome: name } : undefined
                            )
                            setTab(name ? 'connection' : 'step')
                          }}
                          selectedStep={selected}
                          definition={definition}
                          onChange={onChange}
                        />
                      </>
                    ) : (
                      <p className="text-sm text-muted">
                        {selected === FLOW_START_ID
                          ? 'Start has exactly one outgoing connection. Drag its handle to the step that should run first; this replaces the current connection.'
                          : 'Select a step in the graph to edit it.'}
                      </p>
                    )}
                  </div>
                )}
                {tab === 'connection' && selectedStep && connectionOutcome && (
                  <div className="workflow-inspector-form min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                    <h4 className="font-medium">
                      {activeEdge?.group
                        ? `${selectedStep.name ?? selectedStep.id} → ${connectionOutcome} parallel branches`
                        : `${selectedStep.name ?? selectedStep.id} → ${activeEdge?.label ?? connectionOutcome}`}
                    </h4>
                    {edgeTarget && (
                      <p className="text-sm text-muted">
                        {'returnTo' in edgeTarget
                          ? `Requests revisions from ${edgeTarget.returnTo}.`
                          : 'parallel' in edgeTarget
                            ? activeEdge?.branch !== undefined
                              ? `Starts ${edgeTarget.parallel[activeEdge.branch]} alongside ${edgeTarget.parallel.filter((_, index) => index !== activeEdge.branch).join(', ')}.`
                              : `Starts ${edgeTarget.parallel.length} branches together.`
                            : edgeTarget.next === 'finish'
                              ? 'Finishes this path and checks the completion policy.'
                              : `Continues to ${edgeTarget.next}.`}
                      </p>
                    )}
                    {activeEdge?.group && (
                      <p className="text-sm text-muted">
                        These arrows start their branches together. Where the paths converge, the shared step waits for
                        the active branches and runs once. Removing this split disconnects its launch; the branch steps
                        remain.
                      </p>
                    )}
                    <WorkflowStructureEditor
                      mode="step"
                      selectedStep={selected}
                      onlyOutcome={connectionOutcome}
                      onlyBranch={activeEdge?.branch}
                      connectionRemoval={
                        activeEdge
                          ? {
                              label: activeEdge.group ? 'Remove parallel group' : 'Remove connection',
                              help:
                                activeEdge.branch !== undefined
                                  ? 'Removes only this branch connection. Other branches and all steps stay in the flow.'
                                  : activeEdge.group
                                    ? `Removes ${selectedStep.id}’s ${connectionOutcome} outcome and its outgoing arrows. Branch steps keep their other connections but will need a new launch. Undo restores the group.`
                                    : 'Removes this outcome and its handoff. All steps stay in the flow. You can undo this change.',
                              onRemove: removeSelected,
                            }
                          : undefined
                      }
                      onSelectOutcome={(name, previousName) => {
                        setConnectionOutcome(name)
                        setSelectedEdge(
                          name
                            ? previousName && selectedEdge
                              ? {
                                  ...selectedEdge,
                                  outcome: name,
                                  label: selectedEdge.group ? selectedEdge.label : name,
                                }
                              : { from: selected, label: name, step: selected, outcome: name }
                            : undefined
                        )
                        setTab(name ? 'connection' : 'step')
                      }}
                      definition={definition}
                      onChange={onChange}
                    />
                  </div>
                )}
                {tab === 'participants' && (
                  <div className="workflow-inspector-form min-h-0 flex-1 overflow-y-auto p-4">
                    <WorkflowParticipantEditor
                      definition={definition}
                      onChange={onChange}
                      selected={selectedParticipant}
                      onSelect={setSelectedParticipant}
                    />
                  </div>
                )}
                {tab === 'completion' && (
                  <div className="workflow-inspector-form min-h-0 flex-1 overflow-y-auto p-4">
                    <WorkflowCompletionEditor definition={definition} onChange={onChange} />
                  </div>
                )}
                {tab === 'settings' && (
                  <div className="workflow-inspector-form min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                    <WorkflowStructureEditor mode="settings" definition={definition} onChange={onChange} />
                    <WorkflowEventEditor definition={definition} onChange={onChange} />
                    {advancedContent}
                  </div>
                )}
              </aside>
            )}
          </div>
        </section>
      </div>
      {assistantError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {assistantError}
        </p>
      )}
    </div>
  )
}
