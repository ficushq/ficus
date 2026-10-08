import { useEffect, useRef } from 'react'
import type { WorkStreamCompletionMode } from '@ficus/shared'
import { useStableRef } from '../hooks/useStableRef'
import { Modal } from './Modal'

const APPROVAL_MESSAGES: Record<WorkStreamCompletionMode, string> = {
  deliverable: 'Approving accepts the requested deliverable.',
  'pr-merge':
    'Approving completes this work stream even if its pull request has not merged. It does not merge the pull request.',
  'pr-auto-merge':
    'Approving completes this work stream. It does not merge the pull request. If configured and eligible, auto-merge proceeds separately.',
  'review-approval': 'Approving completes this work stream based on review approval.',
  'direct-merge': 'Approving completes this work stream under its direct-merge workflow.',
}

export function approvalConfirmationMessage(
  completionMode: WorkStreamCompletionMode,
  completesOnApproval: boolean
): string {
  if (!completesOnApproval) {
    return 'Approving closes this checkpoint and the work stream continues. It does not complete the work stream.'
  }
  return APPROVAL_MESSAGES[completionMode]
}

interface WorkStreamApprovalConfirmationProps {
  isOpen: boolean
  completionMode: WorkStreamCompletionMode
  completesOnApproval: boolean
  isPending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function WorkStreamApprovalConfirmation({
  isOpen,
  completionMode,
  completesOnApproval,
  isPending,
  error,
  onCancel,
  onConfirm,
}: WorkStreamApprovalConfirmationProps) {
  const submittedRef = useRef(false)
  const isPendingRef = useStableRef(isPending)
  const onCancelRef = useStableRef(onCancel)
  const onConfirmRef = useStableRef(onConfirm)

  useEffect(() => {
    if (!isOpen || (error && !isPending)) submittedRef.current = false
  }, [error, isOpen, isPending])

  const confirmOnce = () => {
    if (isPendingRef.current || submittedRef.current) return
    submittedRef.current = true
    onConfirmRef.current()
  }
  const confirmOnceRef = useStableRef(confirmOnce)

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        confirmOnceRef.current()
      } else if (event.key === 'Escape' && !isPendingRef.current) {
        event.preventDefault()
        onCancelRef.current()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [confirmOnceRef, isOpen, isPendingRef, onCancelRef])

  const title = completesOnApproval ? 'Approve and complete work stream?' : 'Approve checkpoint?'
  const confirmLabel = completesOnApproval ? 'Approve and complete' : 'Approve checkpoint'

  return (
    <Modal isOpen={isOpen} onClose={() => !isPending && onCancel()} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-secondary">{approvalConfirmationMessage(completionMode, completesOnApproval)}</p>
        {error && <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="ficus-button ficus-button-secondary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmOnce}
            disabled={isPending}
            className="ficus-button ficus-button-primary min-h-10 px-3 py-2 text-sm disabled:opacity-50"
          >
            {isPending ? 'Approving…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
