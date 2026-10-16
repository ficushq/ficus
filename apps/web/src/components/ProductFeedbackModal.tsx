import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  isProductFeedbackPage,
  PRODUCT_FEEDBACK_CATEGORIES,
  PRODUCT_FEEDBACK_CATEGORY_LABELS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_MESSAGE_MIN,
  type ProductFeedbackCategory,
} from '@ficus/shared'
import { Modal } from './Modal'
import { ApiError } from '../api/client'
import { sendProductFeedback } from '../api/productFeedback'
import { productFeedbackQueries } from '../queryOptions'
import { productFeedbackQueryKeys } from '../queryKeys'
import { usePermissions } from '../hooks/usePermissions'

const FIELD =
  'ficus-field w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-primary focus:border-accent focus:ring-accent disabled:opacity-60'
const CONNECT_HREF = '/settings?section=mobile-pro&setting=mobile-pro'

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || typeof error.payload !== 'object' || error.payload === null) return undefined
  const code = (error.payload as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Shown when this self-hosted server has no Ficus account connection. */
function NotConnectedNotice({ onConnect }: { onConnect: () => void }) {
  const { can } = usePermissions()
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-panel-border bg-surface-secondary px-3 py-3 text-sm text-secondary"
    >
      <p>
        This server is not connected to a Ficus account, so feedback cannot be sent yet.
        {can('settings:read') ? '' : ' Ask an administrator to connect it.'}
      </p>
      {can('settings:read') && (
        <button
          type="button"
          onClick={onConnect}
          className="ficus-button ficus-button-secondary mt-3 px-3 py-1.5 text-sm font-medium rounded-md"
        >
          Connect Ficus account
        </button>
      )}
    </div>
  )
}

/**
 * "Send feedback to Ficus". Core forwards the report with this instance's own
 * credential; the browser sends only the fields below.
 */
export function ProductFeedbackModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const queryClient = useQueryClient()
  const status = useQuery({ ...productFeedbackQueries.status(), enabled: isOpen })
  const [category, setCategory] = useState<ProductFeedbackCategory | ''>('')
  const [message, setMessage] = useState('')
  const [includeSubmitter, setIncludeSubmitter] = useState(true)
  const send = useMutation({
    mutationFn: sendProductFeedback,
    onError: (error) => {
      if (errorCode(error) === 'not_connected')
        void queryClient.invalidateQueries({ queryKey: productFeedbackQueryKeys.status() })
    },
  })

  const notConnected = status.data?.connected === false
  const trimmedLength = message.trim().length
  const canSend =
    status.data?.connected === true &&
    category !== '' &&
    trimmedLength >= PRODUCT_FEEDBACK_MESSAGE_MIN &&
    trimmedLength <= PRODUCT_FEEDBACK_MESSAGE_MAX &&
    !send.isPending

  const connect = () => {
    onClose()
    navigate(CONNECT_HREF)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSend) return
    send.mutate({
      category,
      message: message.trim(),
      includeSubmitter,
      ...(isProductFeedbackPage(pathname) ? { page: pathname } : {}),
    })
  }

  if (send.isSuccess) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Send feedback to Ficus" closeOnEscape>
        <div role="status" className="space-y-3 text-sm text-secondary">
          <p className="font-medium text-primary">Thanks, your feedback was sent to the Ficus team.</p>
          <p>
            Reference: <code className="font-mono text-primary select-all">{send.data.id}</code>
          </p>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="ficus-button ficus-button-primary min-h-10 px-4 py-2 text-sm rounded-md"
          >
            Done
          </button>
        </div>
      </Modal>
    )
  }

  const sendError = send.isError ? send.error : null
  const disabled = status.data?.connected !== true

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Send feedback to Ficus" closeOnEscape>
      <form onSubmit={submit} aria-label="Send feedback to Ficus">
        <p className="mb-4 text-sm text-secondary">
          Tell the Ficus team what worked, what did not, or what you would like to see.
        </p>
        {status.isError && (
          <div role="alert" className="mb-4 text-sm text-status-danger-600 dark:text-status-danger-400">
            Could not check whether this server can send feedback. Try again later.
          </div>
        )}
        {(notConnected || errorCode(sendError) === 'not_connected') && <NotConnectedNotice onConnect={connect} />}
        <fieldset disabled={disabled || send.isPending} className="space-y-4">
          <div>
            <label htmlFor="product-feedback-category" className="mb-1 block text-sm font-medium text-secondary">
              Category
            </label>
            <select
              id="product-feedback-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as ProductFeedbackCategory | '')}
              className={FIELD}
            >
              <option value="" disabled>
                Choose a category
              </option>
              {PRODUCT_FEEDBACK_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {PRODUCT_FEEDBACK_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="product-feedback-message" className="mb-1 block text-sm font-medium text-secondary">
              Message
            </label>
            <textarea
              id="product-feedback-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={PRODUCT_FEEDBACK_MESSAGE_MAX}
              rows={6}
              placeholder="What happened, and what did you expect?"
              className={FIELD}
            />
            <p
              className={clsx(
                'mt-1 text-xs',
                trimmedLength > 0 && trimmedLength < PRODUCT_FEEDBACK_MESSAGE_MIN ? 'text-secondary' : 'text-muted'
              )}
            >
              {trimmedLength < PRODUCT_FEEDBACK_MESSAGE_MIN
                ? `At least ${PRODUCT_FEEDBACK_MESSAGE_MIN} characters.`
                : `${trimmedLength} / ${PRODUCT_FEEDBACK_MESSAGE_MAX}`}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm text-primary">
            <input
              type="checkbox"
              checked={includeSubmitter}
              onChange={(event) => setIncludeSubmitter(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Include my name and email
              <span className="mt-0.5 block text-xs text-muted">
                So the Ficus team can reply to you. Reports are always linked to the Ficus account of this server’s
                owner, even when this is unchecked.
              </span>
            </span>
          </label>
          <p className="text-xs text-muted">
            The report also includes the Ficus version and the page you are on. Conversations and other workspace
            content are never sent.
          </p>
        </fieldset>
        {sendError && errorCode(sendError) !== 'not_connected' && (
          <div role="alert" className="mt-4 text-sm text-status-danger-600 dark:text-status-danger-400">
            {sendError instanceof ApiError ? sendError.message : 'Feedback could not be sent. Try again later.'}
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="ficus-button ficus-button-secondary px-4 py-2 text-sm font-medium rounded-md"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSend}
            className="ficus-button ficus-button-primary min-h-10 px-4 py-2 text-sm rounded-md disabled:opacity-50"
          >
            {send.isPending ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Opens the shared feedback modal. The modal (and its status query) mounts on
 * first open, and each open starts with a fresh form.
 */
export function SendFeedbackButton({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState(0)
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setSession((value) => value + 1)
          setOpen(true)
        }}
      >
        {children}
      </button>
      {session > 0 && <ProductFeedbackModal key={session} isOpen={open} onClose={() => setOpen(false)} />}
    </>
  )
}
