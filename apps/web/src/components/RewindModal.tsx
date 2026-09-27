import { useState } from 'react'
import { Modal } from './Modal'

interface StepOption {
  agentTypeId: string
  index: number
}

interface RewindModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (step: string, reason: string) => void
  isLoading?: boolean
  steps: StepOption[]
}

export function RewindModal({ isOpen, onClose, onConfirm, isLoading, steps }: RewindModalProps) {
  const [selectedStep, setSelectedStep] = useState('')
  const [reason, setReason] = useState('')

  const handleConfirm = () => {
    if (!selectedStep || !reason.trim()) return
    onConfirm(selectedStep, reason)
  }

  const handleClose = () => {
    setSelectedStep('')
    setReason('')
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Rewind to Previous Step">
      <div className="mb-4">
        <label className="block text-sm font-medium text-secondary mb-2">Target Step</label>
        <select
          value={selectedStep}
          onChange={(e) => setSelectedStep(e.target.value)}
          className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary focus:border-status-progress-500 focus:ring-status-progress-500 px-3 py-2 border"
        >
          <option value="">Select a step to rewind to...</option>
          {steps.map((step) => (
            <option key={step.agentTypeId} value={step.agentTypeId}>
              Step {step.index + 1}: {step.agentTypeId}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-secondary mb-2">Feedback for Agent</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="ficus-field w-full rounded-md border-input-border bg-input-bg text-primary focus:border-status-progress-500 focus:ring-status-progress-500 px-3 py-2 border"
          rows={4}
          placeholder="Describe what needs to be changed..."
          autoFocus
        />
      </div>

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={handleClose}
          disabled={isLoading}
          className="ficus-button px-4 py-2 text-sm font-medium text-secondary bg-surface-secondary rounded-md hover:bg-surface-hover disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!selectedStep || !reason.trim() || isLoading}
          className="ficus-button px-4 py-2 text-sm font-medium text-on-strong bg-status-progress-600 rounded-md hover:bg-status-progress-700 disabled:opacity-50"
        >
          {isLoading ? 'Rewinding...' : 'Rewind'}
        </button>
      </div>
    </Modal>
  )
}
