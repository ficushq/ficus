import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkStreamCompletionMode, WorkStreamWait } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { useActionsApi } from './ActionsApiProvider'
import { settleStreamWait } from './cache'
import { usePermissions } from './permissions'
import { WorkflowDecision } from './WorkflowDecision'
import { ActionText, ErrorNote, VerbButton } from './ui'

const APPROVAL_MESSAGES: Record<WorkStreamCompletionMode, string> = {
  deliverable: 'Harvesting accepts the requested deliverable.',
  'pr-merge':
    'Harvesting completes this work stream even if its pull request has not merged. It does not merge the pull request.',
  'pr-auto-merge':
    'Harvesting completes this work stream. It does not merge the pull request. If configured and eligible, auto-merge proceeds separately.',
  'review-approval': 'Harvesting completes this work stream based on review approval.',
  'direct-merge': 'Harvesting completes this work stream under its direct-merge workflow.',
}

/** What approving really does (mirrors the web's approvalConfirmationMessage). */
export function approvalConfirmationMessage(completionMode: WorkStreamCompletionMode, completesOnApproval: boolean) {
  if (!completesOnApproval) {
    return 'Harvesting closes this checkpoint and the work stream keeps growing. It does not complete the work stream.'
  }
  return APPROVAL_MESSAGES[completionMode]
}

export interface ReviewFormProps {
  workStreamId: string
  squadId: string
  /** The open review wait. */
  wait: WorkStreamWait
  completionMode: WorkStreamCompletionMode
  /** Shown above the buttons; defaults to the wait's own message. */
  message?: string | null
  /** Authoritative capability (PendingAction.canRespond); otherwise checked from squad permissions. */
  canRespond?: boolean
  onOpenAgent?: (agentId: string) => void
  onResolved?: () => void
}

/**
 * Harvest (approve) or Prune (send back with a note) a work stream review wait:
 * `squads.resolveWorkStreamWait(ws, wait, { resolution: 'approved' | 'sent_back', note })`.
 * A workflow-owned wait is decided through the flow instead (WorkflowDecision).
 */
export function ReviewForm(props: ReviewFormProps) {
  if (props.wait.resolutionHandler === 'workflow') {
    return (
      <WorkflowDecision
        workStreamId={props.workStreamId}
        focusWaitId={props.wait.id}
        explainWhenIdle
        onOpenAgent={props.onOpenAgent}
        onDecided={props.onResolved}
      />
    )
  }
  return <ManualReview {...props} />
}

function ManualReview({
  workStreamId,
  squadId,
  wait,
  completionMode,
  message,
  canRespond: actionCanRespond,
  onResolved,
}: ReviewFormProps) {
  const api = useActionsApi()
  const queryClient = useQueryClient()
  const onResolvedRef = useStableRef(onResolved)
  const { can, isLoading } = usePermissions(squadId)
  const canRespond = actionCanRespond ?? (!isLoading && (can('workstreams:respond') || can('workstreams:update')))
  const [mode, setMode] = useState<'idle' | 'confirm' | 'prune'>('idle')
  const [note, setNote] = useState('')
  const noteId = useId()
  const resolve = useMutation({
    mutationFn: (input: { resolution: 'approved' } | { resolution: 'sent_back'; note: string }) =>
      api.resolveWorkStreamWait(workStreamId, wait.id, input),
    onSuccess: async () => {
      setMode('idle')
      setNote('')
      await settleStreamWait(queryClient, { workStreamId, squadId, waitId: wait.id, kind: 'review' })
      onResolvedRef.current?.()
    },
  })
  const completes = wait.completesOnApproval
  const harvestHelp = completes ? 'Approve and deliver' : 'Approve this checkpoint'
  const pruneHelp = completes ? 'Send back with a note' : 'Send this checkpoint back with a note'
  const approving = resolve.isPending && resolve.variables?.resolution === 'approved'
  const pruning = resolve.isPending && resolve.variables?.resolution === 'sent_back'
  const text = message ?? wait.message

  return (
    <div className="g-action">
      {text && <ActionText>{text}</ActionText>}
      {!canRespond ? (
        <p className="g-action-note">You can see this review but don't have permission to decide it.</p>
      ) : mode === 'confirm' ? (
        <div className="g-confirm" role="group" aria-label={completes ? 'Confirm harvest' : 'Confirm checkpoint'}>
          <p className="g-action-note">{approvalConfirmationMessage(completionMode, completes)}</p>
          <div className="g-action-row">
            <VerbButton
              verb="Yes, harvest"
              busyVerb="Harvesting…"
              help={completes ? 'Approve and complete' : 'Approve checkpoint'}
              tone="harvest"
              busy={approving}
              onClick={() => resolve.mutate({ resolution: 'approved' })}
            />
            <VerbButton
              verb="Not yet"
              help="Keep it growing"
              tone="quiet"
              disabled={resolve.isPending}
              onClick={() => setMode('idle')}
            />
          </div>
        </div>
      ) : mode === 'prune' ? (
        <form
          className="g-action"
          onSubmit={(event) => {
            event.preventDefault()
            if (note.trim()) resolve.mutate({ resolution: 'sent_back', note })
          }}
        >
          <label className="g-field" htmlFor={`${noteId}-note`}>
            What needs to change
          </label>
          <textarea
            id={`${noteId}-note`}
            className="g-textarea"
            rows={3}
            placeholder="Describe what needs to be changed…"
            value={note}
            disabled={resolve.isPending}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="g-action-row">
            <VerbButton
              type="submit"
              verb="Prune"
              busyVerb="Pruning…"
              help={completes ? 'Send back with this note' : 'Send this checkpoint back with this note'}
              tone="prune"
              busy={pruning}
              disabled={!note.trim()}
            />
            <VerbButton
              verb="Cancel"
              help="Keep it as it is"
              tone="quiet"
              disabled={resolve.isPending}
              onClick={() => setMode('idle')}
            />
          </div>
        </form>
      ) : (
        <div className="g-action-row">
          <VerbButton verb="Harvest" help={harvestHelp} tone="harvest" onClick={() => setMode('confirm')} />
          <VerbButton verb="Prune" help={pruneHelp} tone="prune" onClick={() => setMode('prune')} />
        </div>
      )}
      <ErrorNote error={resolve.error} />
    </div>
  )
}
