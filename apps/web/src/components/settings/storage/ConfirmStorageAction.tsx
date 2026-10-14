import type { ReactNode } from 'react'
import clsx from 'clsx'
import { useMutation } from '@tanstack/react-query'
import { Modal } from '../../Modal'

interface Props<T> {
  isOpen: boolean
  onClose: () => void
  title: string
  confirmLabel: string
  /** Destructive and irreversible: danger styling. */
  danger?: boolean
  /** What happens and how much space it frees, in plain words. */
  children: ReactNode
  disabled?: boolean
  action: () => Promise<T>
  /** Summarize the server's answer for the page notice. */
  onDone: (result: T) => void
}

/** A storage cleanup confirmation: states the effect, runs the action once, reports failures in place. */
export function ConfirmStorageAction<T>({
  isOpen,
  onClose,
  title,
  confirmLabel,
  danger = false,
  children,
  disabled = false,
  action,
  onDone,
}: Props<T>) {
  const mutation = useMutation({
    mutationFn: action,
    onSuccess: (result) => {
      onDone(result)
      onClose()
    },
  })
  const close = () => {
    mutation.reset()
    onClose()
  }
  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="ficus-button ficus-button-secondary px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={disabled || mutation.isPending}
            className={clsx(
              'ficus-button px-4 py-2 text-sm disabled:opacity-50',
              danger ? 'ficus-button-danger' : 'ficus-button-primary'
            )}
          >
            {mutation.isPending ? 'Working…' : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-secondary">
        {children}
        {mutation.isError && (
          <p role="alert" className="text-status-danger-400">
            {mutation.error instanceof Error ? mutation.error.message : 'The action failed.'}
          </p>
        )}
      </div>
    </Modal>
  )
}
